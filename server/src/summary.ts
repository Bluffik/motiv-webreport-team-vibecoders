import { Router } from 'express';
import { exec, select } from './db.js';
import { nowWall } from './clock.js';
import { requireAdmin, requireAuth } from './auth.js';
import { logAction } from './auditlog.js';
import { dictValues, reloadDicts } from './dicts.js';
import { COLUMNS, buildFilter, diff, rowToApi, validateAlarm } from './alarms.js';
import { stationsForElems, upsertStations, validateStation } from './stations.js';
import { HttpError, str } from './http.js';
import { type Cell, excelDate, readXlsx, toExcelDate, writeXlsx, type Sheet } from './xlsx.js';
import { DICTS, FIELD_LABEL, SECTOR_LABEL, defaultNote, elemKey, isSector, stationCodeOf, type DictKey } from '../../shared/dict.js';
import { formatDuration, humanDateTime, sqlTimeToSeconds } from '../../shared/time.js';

// Сводка ЦОУ в Excel — лист «Аварии на сети СС»: 19 столбцов в порядке ТЗ,
// шапка в две строки, строка с номерами столбцов 1…19, ниже данные.
//  - Загрузка: перенос действующей сводки в систему. Повторная загрузка обновлённой
//    сводки не создаёт дублей — авария узнаётся по паре «сетевой элемент + начало».
//  - Выгрузка: отчёт за период в том же формате, что ЦОУ ведёт сейчас.

const SHEET_NAME = 'Аварии на сети СС';
const DICT_FIELD: Record<DictKey, string> = { napr: 'NAPR', tehc: 'TEHC', netw: 'NETW_TYPE', type: 'ALARM_TYPE' };

// ---------------------------------------------------------------- разбор файла

function findSheet(sheets: Sheet[]): Sheet {
  // \b в JavaScript не работает с кириллицей — ищем «СС» как отдельное слово вручную.
  const byName = sheets.find((s) => /(^|[\s«"])(СС|CC)([\s»"]|$)|сотов/i.test(s.name.trim()));
  if (byName) return byName;
  const byHeader = sheets.find((s) => Array.from(s.rows.values()).slice(0, 10).some((r) => r.some((c) => /сетевой элемент/i.test(c))));
  if (byHeader) return byHeader;
  throw new HttpError(400, `В книге нет листа «${SHEET_NAME}» или листа со столбцом «Сетевой элемент»`);
}

/** Первая строка данных: после строки с номерами столбцов 1…19 или через строку после шапки. */
function dataStart(sheet: Sheet): number {
  const nums = Array.from(sheet.rows.keys()).sort((a, b) => a - b);
  for (const r of nums.slice(0, 15)) {
    const row = sheet.rows.get(r) as string[];
    if (['1', '2', '3', '4', '5', '6'].every((v, i) => String(row[i] || '').trim() === v)) return r + 1;
  }
  for (const r of nums.slice(0, 15)) {
    const row = sheet.rows.get(r) as string[];
    if (/сетевой элемент/i.test(String(row[5] || ''))) return r + 2;
  }
  throw new HttpError(400, 'Не нашёл шапку сводки: в столбце F ожидается «Сетевой элемент, услуга», ниже — строка с номерами 1…19');
}

function cellText(v: string | undefined): string {
  return String(v || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

function cellDate(v: string | undefined): string {
  const s = cellText(v);
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) return excelDate(Number(s));
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')} ${(m[4] || '0').padStart(2, '0')}:${m[5] || '00'}:${m[6] || '00'}`;
  }
  return s;
}

function cellDuration(v: string | undefined): string {
  const s = cellText(v);
  if (!s) return '';
  if (/^\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return formatDuration(Math.round(Number(s) * 86400));
  return s;
}

interface ParsedRow {
  line: number;
  body: Record<string, string>;
}

function parseRows(sheet: Sheet): ParsedRow[] {
  const start = dataStart(sheet);
  const out: ParsedRow[] = [];
  const nums = Array.from(sheet.rows.keys()).filter((r) => r >= start).sort((a, b) => a - b);
  for (const r of nums) {
    const c = sheet.rows.get(r) as string[];
    if (!cellText(c[5]) && !cellText(c[10])) continue; // пустая или служебная строка
    const end = cellText(c[11]);
    const bs = cellText(c[6]);
    const body: Record<string, string> = {
      PW: cellText(c[0]).split('\n').map((x) => x.trim()).filter(Boolean).join(', '),
      NAPR: cellText(c[1]),
      TEHC: cellText(c[2]),
      KATEG: cellText(c[3]).replace(/\.0+$/, ''),
      NETW_TYPE: cellText(c[4]),
      SERV_ELEM: cellText(c[5]).replace(/\n/g, ' '),
      NUMB_RBS: /^[СсCc]$/.test(bs) ? SECTOR_LABEL : bs.replace(/\.0+$/, ''),
      EQIP_TYPE: cellText(c[7]) === '-' ? '' : cellText(c[7]),
      ALARM_TYPE: cellText(c[8]),
      DESCR: cellText(c[9]).replace(/\n/g, ' '),
      BEGIN_TIME: cellDate(c[10]),
      END_TIME: !end || /^нв$/i.test(end) ? 'НВ' : cellDate(end),
      AKB: cellDuration(c[12]),
      DGU: cellDuration(c[13]),
      // Перерыв связи у открытой аварии в сводке «растёт» формулой — фиксируем его при закрытии.
      PROSTOY: !end || /^нв$/i.test(end) ? '' : cellDuration(c[15]),
      ALARM_WHO: cellText(c[17]).replace(/\s*\n\s*/g, ' '),
      DESC_NOTICE: cellText(c[18]),
    };
    out.push({ line: r, body });
  }
  return out;
}

// ---------------------------------------------------------------- загрузка

async function addDictValues(missing: Partial<Record<DictKey, string[]>>): Promise<void> {
  for (const key of Object.keys(missing) as DictKey[]) {
    const values = missing[key] || [];
    if (!values.length) continue;
    const [{ m }] = await select<{ m: number }>('SELECT COALESCE(MAX(sort), 0) AS m FROM dict_items WHERE dict = ?', [key]);
    let sort = Number(m) || 0;
    for (const v of values) {
      sort += 10;
      await exec('INSERT INTO dict_items (dict, value, note, sort, is_active, is_system) VALUES (?, ?, ?, ?, 1, 0)', [key, v, defaultNote(key, v), sort]);
    }
  }
  await reloadDicts();
}

export const summaryRouter = Router();

summaryRouter.post('/import', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const dryRun = b.dryRun === true;
  const addStations = b.addStations === true;
  const fileName = str(b.name).slice(0, 190) || 'сводка.xlsx';
  const base64 = String(b.file || '');
  if (!base64) throw new HttpError(400, 'Выберите файл сводки (.xlsx)');
  let sheets: Sheet[];
  try {
    sheets = readXlsx(Buffer.from(base64, 'base64'));
  } catch (e: any) {
    throw new HttpError(400, e.message || 'Не удалось прочитать файл: нужен .xlsx (Excel 2007 и новее)');
  }
  const sheet = findSheet(sheets);
  const parsed = parseRows(sheet);
  if (!parsed.length) throw new HttpError(400, `На листе «${sheet.name}» нет строк с авариями`);
  const now = nowWall();

  // Новые значения справочников (например, ТЦ, которого ещё нет) — добавятся при загрузке.
  const missing: Partial<Record<DictKey, string[]>> = {};
  for (const d of DICTS) {
    const known = dictValues(d.key);
    const vals = Array.from(new Set(parsed.map((p) => p.body[DICT_FIELD[d.key]]).filter(Boolean)));
    const miss = vals.filter((v) => known.indexOf(v) < 0 && v.length <= 64);
    if (miss.length) missing[d.key] = miss;
  }

  const errors: Array<{ line: number; message: string }> = [];
  const valid: Array<{ line: number; v: Record<string, any>; body: Record<string, string> }> = [];
  const seen = new Map<string, number>();
  for (const p of parsed) {
    try {
      const v = validateAlarm(p.body, now, missing);
      const key = elemKey(String(v.SERV_ELEM)) + '|' + String(v.BEGIN_TIME).slice(0, 16);
      if (seen.has(key)) {
        errors.push({ line: p.line, message: `Повтор строки ${seen.get(key)}: тот же сетевой элемент и время начала` });
        continue;
      }
      seen.set(key, p.line);
      valid.push({ line: p.line, v, body: p.body });
    } catch (e: any) {
      const fields = e instanceof HttpError && e.fields ? e.fields : null;
      errors.push({
        line: p.line,
        message: fields ? Object.entries(fields).map(([k, m]) => `${(FIELD_LABEL as Record<string, string>)[k] || k} — ${m}`).join('; ') : String(e.message || e),
      });
    }
  }

  // Уже загруженные аварии — по паре «сетевой элемент + начало».
  const begins = valid.map((x) => String(x.v.BEGIN_TIME)).sort();
  const existing = new Map<string, any>();
  if (begins.length) {
    const rows = await select('SELECT * FROM alarms WHERE BEGIN_TIME >= ? AND BEGIN_TIME <= ?', [
      begins[0].slice(0, 16) + ':00', begins[begins.length - 1].slice(0, 16) + ':59',
    ]);
    for (const r of rows) existing.set(elemKey(r.SERV_ELEM) + '|' + String(r.BEGIN_TIME).slice(0, 16), r);
  }
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const toCreate: typeof valid = [];
  const toUpdate: Array<{ id: number; v: Record<string, any>; changes: Record<string, unknown> }> = [];
  for (const x of valid) {
    const ex = existing.get(elemKey(String(x.v.SERV_ELEM)) + '|' + String(x.v.BEGIN_TIME).slice(0, 16));
    if (!ex) toCreate.push(x);
    else {
      const changes = diff(ex, x.v);
      if (Object.keys(changes).length) toUpdate.push({ id: ex.ID, v: x.v, changes });
      else unchanged++;
    }
  }

  // Новые значения справочников добавляем сразу: от них зависят проверки объектов инвентаря.
  if (!dryRun) await addDictValues(missing);

  // Объекты, которых нет в инвентаре.
  const elems = Array.from(new Set(valid.map((x) => String(x.v.SERV_ELEM))));
  const known = await stationsForElems(elems);
  const newStations: Array<Record<string, any>> = [];
  const stationKeys = new Set<string>();
  for (const x of valid) {
    const e = String(x.v.SERV_ELEM);
    if (known.has(e) || !stationCodeOf(e)) continue;
    try {
      const st = validateStation({
        serv_elem: e, napr: x.v.NAPR, tehc: x.v.TEHC || '', netw_type: x.v.NETW_TYPE,
        eqip_type: /^\d{4}$/.test(String(x.v.EQIP_TYPE || '')) ? x.v.EQIP_TYPE : '',
        bs_count: /^\d+$/.test(String(x.v.NUMB_RBS)) ? x.v.NUMB_RBS : '1',
      });
      if (stationKeys.has(String(st.elem_key))) continue;
      stationKeys.add(String(st.elem_key));
      newStations.push(st);
    } catch {
      /* объект без направления/ТЦ из справочника — пропускаем, его можно добавить вручную */
    }
  }

  let stationsCreated = 0;
  if (!dryRun) {
    for (const x of toCreate) {
      const cols = COLUMNS.filter((c) => c in x.v);
      const r = await exec(`INSERT INTO alarms (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => x.v[c]));
      await logAction(req.user!, 'alarm_create', r.insertId, Object.assign({ import: fileName }, x.v));
      created++;
    }
    for (const u of toUpdate) {
      const cols = COLUMNS.filter((c) => c in u.v);
      await exec(`UPDATE alarms SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE ID = ?`, [...cols.map((c) => u.v[c]), u.id]);
      await logAction(req.user!, 'alarm_update', u.id, Object.assign({ import: fileName }, u.changes));
      updated++;
    }
    if (addStations && newStations.length) stationsCreated = (await upsertStations(newStations as any, false)).created;
    await logAction(req.user!, 'alarm_import', null, {
      file: fileName, sheet: sheet.name, rows: parsed.length, created, updated, unchanged, errors: errors.length,
      dict: missing, stations: stationsCreated,
    });
  }

  res.json({
    sheet: sheet.name,
    sheets: sheets.map((s) => s.name),
    rows: parsed.length,
    valid: valid.length,
    toCreate: toCreate.length,
    toUpdate: toUpdate.length,
    unchanged,
    created,
    updated,
    errors: errors.slice(0, 100),
    errorCount: errors.length,
    newDict: missing,
    newStations: newStations.length,
    stationsCreated,
    period: begins.length ? { from: begins[0], to: begins[begins.length - 1] } : null,
    open: valid.filter((x) => String(x.v.END_TIME).indexOf('0000') === 0).length,
  });
});

// ---------------------------------------------------------------- выгрузка

const HEAD_TOP: Array<[string, string?]> = [
  ['Номер NTT/PW'], ['Зона ответственности'], [''], ['Категория'], ['Тип сети'], ['Сетевой элемент, услуга'], ['Кол-во БС'],
  ['Тип оборудования'], ['Авария'], [''], ['Время аварии'], [''], ['Время работы от резервного питания'], [''],
  ['Длительность аварии'], ['Время перерыва связи'], ['Общее время простоя БС'], ['Действия по устранению'], [''],
];
const HEAD_SUB = ['', 'Территориальное направление', 'ТЦ', '', '', '', '', '', 'Тип', 'Описание', 'начало', 'окончание', 'АКБ', 'ГУ', '', '', '', 'Уведомление об аварии (Кому)', 'Описание/примечание'];
const MERGES = ['A3:A4', 'B3:C3', 'D3:D4', 'E3:E4', 'F3:F4', 'G3:G4', 'H3:H4', 'I3:J3', 'K3:L3', 'M3:N3', 'O3:O4', 'P3:P4', 'Q3:Q4', 'R3:S3'];
const WIDTHS = [13, 11, 7, 9, 10, 44, 7, 12, 8, 30, 14, 14, 9, 9, 11, 11, 11, 30, 56];

const dur = (sec: number | null | undefined): Cell => (sec === null || sec === undefined ? { v: null, s: 'dur' } : { v: sec / 86400, s: 'dur' });

summaryRouter.get('/export.xlsx', requireAuth, async (req, res) => {
  const now = nowWall();
  const { whereSql, params } = buildFilter(req.query);
  const rows = await select(`SELECT * FROM alarms ${whereSql} ORDER BY BEGIN_TIME ASC, ID ASC LIMIT 100000`, params);
  const items = rows.map((r) => rowToApi(r, now));
  const from = str(req.query.from);
  const to = str(req.query.to);
  const period = from || to ? `${from ? humanDateTime(from + ' 00:00:00').slice(0, 10) : '…'} — ${to ? humanDateTime(to + ' 00:00:00').slice(0, 10) : '…'}` : 'все аварии';

  const sheetRows: Cell[][] = [];
  const blank = (n: number): Cell[] => Array.from({ length: n }, () => ({ v: null }));
  const r1 = blank(19);
  r1[0] = { v: `${SHEET_NAME}: ${period}`, s: 'title' };
  r1[10] = { v: 'текущее время', s: 'note' };
  r1[11] = { v: toExcelDate(now), s: 'date' };
  sheetRows.push(r1);
  const r2 = blank(19);
  r2[1] = { v: 'Формат: Текстовый', s: 'note' };
  r2[10] = { v: 'Формат: Дата_дд.мм.гг Время_ чч:мм', s: 'note' };
  r2[14] = { v: 'Формат: Время 37:30:55', s: 'note' };
  r2[17] = { v: 'Формат: Текстовый', s: 'note' };
  sheetRows.push(r2);
  sheetRows.push(HEAD_TOP.map(([t]) => ({ v: t || null, s: 'head' as const })));
  sheetRows.push(HEAD_SUB.map((t) => ({ v: t || null, s: 'head' as const })));
  sheetRows.push(Array.from({ length: 19 }, (_x, i) => ({ v: i + 1, s: 'head' as const })));

  for (const a of items) {
    const bs = a.NUMB_RBS && /^\d+$/.test(a.NUMB_RBS) ? Number(a.NUMB_RBS) : a.NUMB_RBS;
    sheetRows.push([
      { v: a.PW, s: 'text' },
      { v: a.NAPR, s: 'center' },
      { v: a.TEHC, s: 'center' },
      { v: a.KATEG, s: 'num' },
      { v: a.NETW_TYPE, s: 'center' },
      { v: a.SERV_ELEM, s: 'text' },
      { v: bs === null ? null : bs, s: isSector(a.NUMB_RBS) ? 'center' : 'num' },
      { v: a.EQIP_TYPE || '-', s: 'center' },
      { v: a.ALARM_TYPE, s: 'center' },
      { v: a.DESCR, s: 'text' },
      { v: a.BEGIN_TIME ? toExcelDate(a.BEGIN_TIME) : null, s: 'date' },
      a.IS_OPEN ? { v: 'НВ', s: 'open' } : { v: a.END_TIME ? toExcelDate(a.END_TIME) : null, s: 'date' },
      dur(sqlTimeToSeconds(a.AKB)),
      dur(sqlTimeToSeconds(a.DGU)),
      dur(a.LENGTH_SEC),
      dur(sqlTimeToSeconds(a.PROSTOY)),
      dur(a.COMMON_SEC),
      { v: a.ALARM_WHO, s: 'text' },
      { v: a.DESC_NOTICE, s: 'text' },
    ]);
  }

  const buf = writeXlsx([{
    name: SHEET_NAME,
    rows: sheetRows,
    merges: MERGES,
    widths: WIDTHS,
    freezeRows: 5,
    autoFilter: `A5:S${Math.max(6, sheetRows.length)}`,
  }]);
  const name = `svodka_SS_${from || 'start'}_${to || now.slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent('Сводка_СС_' + (from || 'начало') + '_' + (to || now.slice(0, 10)) + '.xlsx')}`);
  res.send(buf);
});
