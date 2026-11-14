import crypto from 'node:crypto';
import { Router } from 'express';
import { exec, select, stationKey } from './db.js';
import { nowWall } from './clock.js';
import { requireAdmin, requireAuth } from './auth.js';
import { logAction } from './auditlog.js';
import { dictValues } from './dicts.js';
import { HttpError, intParam, str } from './http.js';
import { WHOLE_NETWORK, elemKey, formatElem, stationCodeOf } from '../../shared/dict.js';
import { ZERO_DATETIME, addDays } from '../../shared/time.js';

// Инвентарь базовых станций (ответ куратора на вопросы 12, 22, 23: «инвентарь — на вас»).
// «Сетевой элемент» в сводке ЦОУ: «VJ_K29 — Базовая станция «Кедровый-110»» — код и название.
// В обезличенной сводке один код встречается у разных объектов, поэтому станция
// опознаётся по паре «код — название»; по одному коду — только если он единственный.

const CODE_RE = /^[A-ZА-ЯЁ0-9]{1,8}([_\-./][A-ZА-ЯЁ0-9]{1,8}){0,3}$/;

export interface Station {
  id: number;
  code: string;
  address: string;
  napr: string | null;
  tehc: string | null;
  netw_type: string | null;
  eqip_type: string | null;
  bs_count: number;
  akb_minutes: number | null;
  has_dgu: boolean;
  note: string | null;
  is_active: boolean;
  updated_at: string;
  serv_elem: string;
}

export function mapStation(r: any): Station {
  return {
    id: r.id,
    code: r.code,
    address: r.address,
    napr: r.napr,
    tehc: r.tehc,
    netw_type: r.netw_type,
    eqip_type: r.eqip_type,
    bs_count: Number(r.bs_count) || 1,
    akb_minutes: r.akb_minutes === null || r.akb_minutes === undefined ? null : Number(r.akb_minutes),
    has_dgu: !!r.has_dgu,
    note: r.note,
    is_active: !!r.is_active,
    updated_at: r.updated_at,
    serv_elem: formatElem(r.code, r.address),
  };
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

function elemHash(s: string): string {
  return crypto.createHash('sha1').update(elemKey(s)).digest('hex');
}

// ---------------------------------------------------------------- сопоставление аварий со станциями

interface StationIndex {
  byKey: Map<string, any>;
  byCode: Map<string, any[]>;
}

function buildIndex(rows: any[]): StationIndex {
  const byKey = new Map<string, any>();
  const byCode = new Map<string, any[]>();
  for (const r of rows) {
    byKey.set(r.elem_key, r);
    const c = String(r.code).toUpperCase();
    const list = byCode.get(c);
    if (list) list.push(r);
    else byCode.set(c, [r]);
  }
  return { byKey, byCode };
}

/** Станция для строки «Сетевой элемент»: точное совпадение «код — название» или единственная станция с таким кодом. */
function resolveIn(idx: StationIndex, elem: string | null | undefined): any | null {
  if (!elem) return null;
  const hit = idx.byKey.get(elemHash(elem));
  if (hit) return hit;
  const code = stationCodeOf(elem);
  const list = code ? idx.byCode.get(code) : undefined;
  return list && list.length === 1 ? list[0] : null;
}

/** Станции для списка сетевых элементов (табло: прогноз АКБ). Ключ результата — исходная строка. */
export async function stationsForElems(elems: Array<string | null>): Promise<Map<string, Station>> {
  const out = new Map<string, Station>();
  const uniq = Array.from(new Set(elems.filter(Boolean) as string[]));
  if (!uniq.length) return out;
  const keys = uniq.map(elemHash);
  const codes = Array.from(new Set(uniq.map(stationCodeOf).filter(Boolean) as string[]));
  const rows = await select(
    `SELECT * FROM stations WHERE elem_key IN (?)${codes.length ? ' OR code IN (?)' : ''}`,
    codes.length ? [keys, codes] : [keys],
  );
  const idx = buildIndex(rows);
  for (const e of uniq) {
    const r = resolveIn(idx, e);
    if (r) out.set(e, mapStation(r));
  }
  return out;
}

/** Аварии по станциям: за 90 дней, открытые сейчас, последняя. */
async function alarmStats(): Promise<Map<number, { alarms90: number; open_now: number; last_alarm: string | null }>> {
  const idx = buildIndex(await select('SELECT id, code, elem_key FROM stations'));
  const since = addDays(nowWall().slice(0, 10), -90) + ' 00:00:00';
  const rows = await select(
    `SELECT SERV_ELEM AS e, SUM(BEGIN_TIME >= ?) AS c90,
            SUM(END_TIME IS NULL OR END_TIME = '${ZERO_DATETIME}') AS o, MAX(BEGIN_TIME) AS last
       FROM alarms WHERE SERV_ELEM IS NOT NULL AND SERV_ELEM <> '' GROUP BY SERV_ELEM`,
    [since],
  );
  const out = new Map<number, { alarms90: number; open_now: number; last_alarm: string | null }>();
  for (const r of rows) {
    const st = resolveIn(idx, r.e);
    if (!st) continue;
    const cur = out.get(st.id) || { alarms90: 0, open_now: 0, last_alarm: null };
    cur.alarms90 += Number(r.c90) || 0;
    cur.open_now += Number(r.o) || 0;
    if (r.last && (!cur.last_alarm || r.last > cur.last_alarm)) cur.last_alarm = r.last;
    out.set(st.id, cur);
  }
  return out;
}

// ---------------------------------------------------------------- проверка ввода

type StationValues = Record<string, string | number | null>;

function validateStation(b: any): StationValues {
  const errors: Record<string, string> = {};
  const v: StationValues = {};
  // Целый «Сетевой элемент» из сводки (CSV со столбцом «Сетевой элемент, услуга») делим на код и название.
  let code = str(b?.code);
  let address = str(b?.address);
  const elem = str(b?.serv_elem);
  if (elem && (!code || !address)) {
    const c = stationCodeOf(elem);
    if (c) {
      code = code || c;
      address = address || elem.replace(/^\s*\S+\s*(?:[—–,]|\s-\s)\s*/, '').trim();
    }
  }
  code = code.toUpperCase().replace(/\s+/g, '');
  if (!CODE_RE.test(code)) errors.code = 'Буквы и цифры, можно «_» или «-»: например VJ_K29 или ЕКБ-0412';
  v.code = code;
  if (!address) errors.address = 'Укажите название или адрес объекта';
  else if (address.length > 400) errors.address = 'Не длиннее 400 символов';
  v.address = address;
  v.elem_key = stationKey(code, address);

  const pick = (key: string, dict: 'napr' | 'tehc' | 'netw', required: boolean) => {
    const val = str(b?.[key]);
    if (!val) {
      if (required) errors[key] = 'Выберите значение';
      v[key] = null;
    } else if (dictValues(dict).indexOf(val) < 0) {
      errors[key] = 'Выберите значение из списка';
      v[key] = null;
    } else v[key] = val;
  };
  pick('napr', 'napr', true);
  pick('tehc', 'tehc', v.napr !== WHOLE_NETWORK);
  pick('netw_type', 'netw', false);

  const eq = str(b?.eqip_type);
  if (eq.length > 190) errors.eqip_type = 'Не длиннее 190 символов';
  v.eqip_type = eq && eq !== '-' ? eq : null;

  const bs = parseInt(str(b?.bs_count) || '1', 10);
  if (isNaN(bs) || bs < 1 || bs > 999) errors.bs_count = 'От 1 до 999';
  v.bs_count = isNaN(bs) ? 1 : bs;

  const akbRaw = str(b?.akb_minutes);
  if (akbRaw === '') v.akb_minutes = null;
  else {
    const akb = parseInt(akbRaw, 10);
    if (isNaN(akb) || akb < 0 || akb > 10080 || !/^\d+$/.test(akbRaw)) errors.akb_minutes = 'Минуты, от 0 до 10080';
    v.akb_minutes = isNaN(akb) ? null : akb;
  }
  v.has_dgu = b?.has_dgu === true || b?.has_dgu === 1 || /^(1|true|да|есть|yes)$/i.test(str(b?.has_dgu)) ? 1 : 0;
  const note = str(b?.note);
  if (note.length > 450) errors.note = 'Не длиннее 450 символов';
  v.note = note || null;
  v.is_active = b?.is_active === false || b?.is_active === 0 || /^(0|false|нет)$/i.test(str(b?.is_active)) ? 0 : 1;

  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);
  return v;
}

const COLS = ['code', 'address', 'elem_key', 'napr', 'tehc', 'netw_type', 'eqip_type', 'bs_count', 'akb_minutes', 'has_dgu', 'note', 'is_active'];

// ---------------------------------------------------------------- CSV

const CSV_HEADERS: Array<[string, string]> = [
  ['code', 'Код БС'],
  ['address', 'Название, адрес'],
  ['napr', 'Направление'],
  ['tehc', 'ТЦ'],
  ['netw_type', 'Тип сети'],
  ['eqip_type', 'Тип оборудования'],
  ['bs_count', 'Количество БС'],
  ['akb_minutes', 'Автономность АКБ, мин'],
  ['has_dgu', 'ДГУ'],
  ['note', 'Примечание'],
  ['is_active', 'Активна'],
];

function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Разбор CSV: разделитель «;», «,» или табуляция (по первой строке), кавычки по RFC 4180. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const counts = [';', ',', '\t'].map((c) => firstLine.split(c).length);
  const sep = [';', ',', '\t'][counts.indexOf(Math.max.apply(null, counts))];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function headerKey(h: string): string | null {
  const s = h.trim().toLowerCase().replace(/^'/, '').replace(/\s+/g, ' ');
  for (const [key, label] of CSV_HEADERS) {
    if (s === key || s === label.toLowerCase()) return key;
  }
  const aliases: Record<string, string> = {
    'код': 'code', 'код объекта': 'code', 'бс': 'code', 'адрес': 'address', 'адрес бс': 'address', 'название': 'address',
    'объект': 'address', 'сетевой элемент': 'serv_elem', 'сетевой элемент, услуга': 'serv_elem', 'базовая станция': 'serv_elem',
    'тц': 'tehc', 'тех. центр': 'tehc', 'тех. центр, отделение': 'tehc', 'направление': 'napr', 'территориальное направление': 'napr',
    'сеть': 'netw_type', 'оборудование': 'eqip_type', 'тип rbs': 'eqip_type', 'кол-во бс': 'bs_count', 'акб': 'akb_minutes',
    'акб, мин': 'akb_minutes', 'дгу': 'has_dgu', 'гу': 'has_dgu',
  };
  return aliases[s] || null;
}

// ---------------------------------------------------------------- маршруты

export const stationsRouter = Router();

/** Подсказки для формы аварии: активные станции по коду или названию. */
stationsRouter.get('/search', requireAuth, async (req, res) => {
  const q = str(req.query.q).slice(0, 60);
  if (q.length < 2) {
    res.json({ items: [] });
    return;
  }
  const like = '%' + escapeLike(q) + '%';
  const rows = await select(
    `SELECT * FROM stations WHERE is_active = 1 AND (code LIKE ? OR address LIKE ? OR CONCAT(code, ' — ', address) LIKE ?)
      ORDER BY (code LIKE ?) DESC, code, address LIMIT 12`,
    [like, like, like, escapeLike(q.toUpperCase()) + '%'],
  );
  res.json({ items: rows.map(mapStation) });
});

stationsRouter.get('/export.csv', requireAuth, async (_req, res) => {
  const rows = await select('SELECT * FROM stations ORDER BY code, address');
  const lines = [CSV_HEADERS.map((h) => h[1]).join(';')];
  for (const r of rows) {
    lines.push(CSV_HEADERS.map(([k]) => csvCell(k === 'has_dgu' || k === 'is_active' ? (r[k] ? 'да' : 'нет') : r[k])).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="stations.csv"; filename*=UTF-8''${encodeURIComponent('инвентарь_БС.csv')}`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

/** Список с отбором и «здоровьем» станции: аварии за 90 дней, открытые, последняя авария. */
stationsRouter.get('/', requireAuth, async (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const q = str(req.query.q);
  if (q) {
    where.push('(code LIKE ? OR address LIKE ? OR eqip_type LIKE ?)');
    const like = '%' + escapeLike(q) + '%';
    params.push(like, like, like);
  }
  for (const [p, col] of [['tehc', 'tehc'], ['napr', 'napr'], ['netw', 'netw_type']]) {
    const v = str(req.query[p]);
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  const active = str(req.query.active);
  if (active === '1') where.push('is_active = 1');
  if (active === '0') where.push('is_active = 0');
  if (str(req.query.akb) === 'none') where.push('akb_minutes IS NULL');
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await select(`SELECT * FROM stations ${whereSql}`, params);
  const stats = await alarmStats();
  const items = rows.map((r) => {
    const s = stats.get(r.id);
    return Object.assign(mapStation(r), { alarms90: s ? s.alarms90 : 0, open_now: s ? s.open_now : 0, last_alarm: s ? s.last_alarm : null });
  });
  const byCode = (a: Station, b: Station) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.address < b.address ? -1 : 1);
  const sort = str(req.query.sort);
  items.sort((a, b) => {
    if (sort === 'tehc' && (a.tehc || '') !== (b.tehc || '')) return (a.tehc || '') < (b.tehc || '') ? -1 : 1;
    if (sort === 'alarms' && a.alarms90 !== b.alarms90) return b.alarms90 - a.alarms90;
    if (sort === 'last' && (a.last_alarm || '') !== (b.last_alarm || '')) return (b.last_alarm || '') < (a.last_alarm || '') ? -1 : 1;
    if (sort === 'akb' && a.akb_minutes !== b.akb_minutes) {
      if (a.akb_minutes === null) return 1;
      if (b.akb_minutes === null) return -1;
      return a.akb_minutes - b.akb_minutes;
    }
    return byCode(a, b);
  });
  const pageSize = intParam(req.query.pageSize, 50, 10, 500);
  const page = intParam(req.query.page, 1, 1, 100000);
  const [summary] = await select(
    `SELECT COUNT(*) AS total, SUM(is_active) AS active, SUM(akb_minutes IS NULL) AS no_akb, SUM(has_dgu) AS dgu FROM stations`,
  );
  res.json({
    items: items.slice((page - 1) * pageSize, page * pageSize),
    total: items.length,
    page,
    pageSize,
    summary: {
      total: Number(summary.total) || 0,
      active: Number(summary.active) || 0,
      noAkb: Number(summary.no_akb) || 0,
      dgu: Number(summary.dgu) || 0,
    },
  });
});

/** Станция для введённого «Сетевого элемента» — форма аварии показывает её данные (АКБ, ДГУ). */
stationsRouter.get('/resolve', requireAuth, async (req, res) => {
  const elem = str(req.query.elem).slice(0, 450);
  const map = elem ? await stationsForElems([elem]) : new Map<string, Station>();
  res.json({ item: map.get(elem) || null });
});

stationsRouter.get('/:id', requireAuth, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [r] = await select('SELECT * FROM stations WHERE id = ?', [id]);
  if (!r) throw new HttpError(404, 'Станция не найдена');
  const st = mapStation(r);
  // Кандидаты — аварии, где сетевой элемент начинается с кода; дальше сопоставитель оставляет свои.
  const sameCode = await select('SELECT id, code, elem_key FROM stations WHERE code = ?', [r.code]);
  const idx = buildIndex(sameCode);
  const candidates = await select(
    `SELECT ID, SERV_ELEM, BEGIN_TIME, END_TIME, ALARM_TYPE, KATEG, DESCR, LENGHT, PROSTOY
       FROM alarms WHERE SERV_ELEM LIKE ? ORDER BY BEGIN_TIME DESC LIMIT 500`,
    [escapeLike(r.code) + '%'],
  );
  const alarms = candidates.filter((a) => {
    const hit = resolveIn(idx, a.SERV_ELEM);
    return hit && hit.id === id;
  }).slice(0, 30);
  res.json({
    item: st,
    alarms: alarms.map((a) => Object.assign({}, a, { IS_OPEN: !a.END_TIME || String(a.END_TIME).indexOf('0000') === 0 })),
  });
});

stationsRouter.post('/', requireAdmin, async (req, res) => {
  const v = validateStation(req.body);
  const exists = await select('SELECT id FROM stations WHERE elem_key = ?', [v.elem_key]);
  if (exists.length) throw new HttpError(400, 'Проверьте поля', { code: 'Станция с таким кодом и названием уже есть' });
  const r = await exec(
    `INSERT INTO stations (${COLS.join(', ')}, updated_at) VALUES (${COLS.map(() => '?').join(', ')}, ?)`,
    [...COLS.map((c) => v[c]), nowWall()],
  );
  await logAction(req.user!, 'station_create', null, { code: v.code, address: v.address });
  const [row] = await select('SELECT * FROM stations WHERE id = ?', [r.insertId]);
  res.status(201).json({ item: mapStation(row) });
});

stationsRouter.put('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [before] = await select('SELECT * FROM stations WHERE id = ?', [id]);
  if (!before) throw new HttpError(404, 'Станция не найдена');
  const v = validateStation(req.body);
  const dup = await select('SELECT id FROM stations WHERE elem_key = ? AND id <> ?', [v.elem_key, id]);
  if (dup.length) throw new HttpError(400, 'Проверьте поля', { code: 'Станция с таким кодом и названием уже есть' });
  await exec(`UPDATE stations SET ${COLS.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, [
    ...COLS.map((c) => v[c]), nowWall(), id,
  ]);
  const changes: Record<string, unknown> = { code: before.code };
  for (const c of COLS) {
    if (c === 'elem_key') continue;
    const a = before[c] === null || before[c] === undefined ? '' : String(before[c]);
    const b = v[c] === null || v[c] === undefined ? '' : String(v[c]);
    if (a !== b) changes[c] = [before[c], v[c]];
  }
  await logAction(req.user!, 'station_update', null, changes);
  const [row] = await select('SELECT * FROM stations WHERE id = ?', [id]);
  res.json({ item: mapStation(row) });
});

stationsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [row] = await select('SELECT * FROM stations WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'Станция не найдена');
  await exec('DELETE FROM stations WHERE id = ?', [id]);
  await logAction(req.user!, 'station_delete', null, { code: row.code, address: row.address });
  res.json({ ok: true });
});

/**
 * Записывает станции. Существующая станция — та же пара «код — название»; если такой нет,
 * а код в файле один и в инвентаре одна станция с этим кодом — это она же с новым
 * названием или адресом (выгрузка Site Info). Иначе станция добавляется.
 */
export async function upsertStations(valid: StationValues[], matchByCode = true): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const now = nowWall();
  const inFile = new Map<string, number>();
  for (const v of valid) inFile.set(String(v.code), (inFile.get(String(v.code)) || 0) + 1);
  for (const v of valid) {
    let [ex] = await select('SELECT id FROM stations WHERE elem_key = ?', [v.elem_key]);
    if (!ex && matchByCode && inFile.get(String(v.code)) === 1) {
      const same = await select('SELECT id FROM stations WHERE code = ?', [v.code]);
      if (same.length === 1) ex = same[0];
    }
    if (ex) {
      await exec(`UPDATE stations SET ${COLS.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, [
        ...COLS.map((c) => v[c]), now, ex.id,
      ]);
      updated++;
    } else {
      await exec(`INSERT INTO stations (${COLS.join(', ')}, updated_at) VALUES (${COLS.map(() => '?').join(', ')}, ?)`, [
        ...COLS.map((c) => v[c]), now,
      ]);
      created++;
    }
  }
  return { created, updated };
}

export { validateStation };

/** Загрузка инвентаря из CSV (выгрузка Site Info, Excel или столбцы сводки): новые объекты добавляются, существующие обновляются. */
stationsRouter.post('/import', requireAdmin, async (req, res) => {
  const text = String(req.body?.csv || '');
  const dryRun = req.body?.dryRun === true;
  if (!text.trim()) throw new HttpError(400, 'Файл пустой');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new HttpError(400, 'Нужна строка заголовков и хотя бы одна строка данных');
  const keys = rows[0].map(headerKey);
  const hasElem = keys.indexOf('serv_elem') >= 0;
  if (!hasElem && (keys.indexOf('code') < 0 || keys.indexOf('address') < 0)) {
    throw new HttpError(400, 'В заголовке нужны столбцы «Код БС» и «Название, адрес» или «Сетевой элемент»');
  }
  const errors: Array<{ line: number; message: string }> = [];
  const valid: StationValues[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const obj: Record<string, string> = {};
    keys.forEach((k, j) => {
      if (k) obj[k] = (rows[i][j] || '').trim().replace(/^'/, '');
    });
    try {
      const v = validateStation(obj);
      if (seen.has(String(v.elem_key))) continue;
      seen.add(String(v.elem_key));
      valid.push(v);
    } catch (e: any) {
      const label = (k: string) => (CSV_HEADERS.find((h) => h[0] === k) || [k, k])[1];
      const f = e instanceof HttpError && e.fields ? Object.entries(e.fields).map(([k, m]) => `${label(k)} — ${m}`).join('; ') : e.message;
      errors.push({ line: i + 1, message: f });
    }
  }
  let created = 0;
  let updated = 0;
  if (!dryRun) {
    const r = await upsertStations(valid);
    created = r.created;
    updated = r.updated;
    await logAction(req.user!, 'station_import', null, { created, updated, errors: errors.length });
  }
  res.json({ ok: true, rows: rows.length - 1, valid: valid.length, created, updated, errors: errors.slice(0, 50) });
});
