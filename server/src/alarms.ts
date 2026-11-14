import { Router, type Request } from 'express';
import { exec, pool, select } from './db.js';
import { nowWall } from './clock.js';
import { requireAdmin, requireAuth, requireEditor } from './auth.js';
import { logAction } from './auditlog.js';
import { dictValues } from './dicts.js';
import { checkLongAlarms, notifyAlarm, rememberOrigin } from './notify.js';
import { stationsForElems } from './stations.js';
import { HttpError, intParam, str } from './http.js';
import {
  CATEGORIES, FIELDS, MAX_BS, SECTOR_LABEL, TEXT_MAX, WHOLE_NETWORK, formatBs, normalizeBs, stationCodeOf, type DictKey,
} from '../../shared/dict.js';
import {
  OPEN_END_LABEL, TIME_MAX_SECONDS, ZERO_DATETIME, addDays, computeCommonSeconds, computeLengthSeconds,
  formatDateTime, formatDuration, humanDateTime, isOpenEnd, parseDateTime, parseDuration, sqlTimeToSeconds,
} from '../../shared/time.js';

/** Столбцы таблицы alarms по ТЗ (без ID). */
export const COLUMNS = FIELDS.map((f) => f.key);

const OPEN_COND = `(END_TIME IS NULL OR END_TIME = '${ZERO_DATETIME}')`;
const lengthExpr = (now: string) => `TIMESTAMPDIFF(SECOND, BEGIN_TIME, IF(${OPEN_COND}, ${pool.escape(now)}, END_TIME))`;
/** Количество БС из текстового столбца: число как есть, «С» (сектор) — 1 (ответ куратора, вопрос 2). */
const BS_MULT = "IF(NUMB_RBS REGEXP '^[1-9][0-9]*$', CAST(NUMB_RBS AS UNSIGNED), 1)";
const BS_NUM = "IF(NUMB_RBS REGEXP '^[1-9][0-9]*$', CAST(NUMB_RBS AS UNSIGNED), 0)";
export const COMMON_EXPR = `TIME_TO_SEC(PROSTOY) * ${BS_MULT}`;
/** Допуск на расхождение часов при проверке «не в будущем». */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- проверка ввода

type AlarmValues = Record<string, string | number | null>;

function text(v: unknown): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

/**
 * Проверяет поля аварии и вычисляет автоматические поля (LENGHT, COMMON_PROSTOY).
 * Возвращает значения для БД; при ошибках бросает 400 с текстами по каждому полю.
 */
export function validateAlarm(body: any, now: string, extra?: Partial<Record<DictKey, string[]>>): AlarmValues {
  const b = body || {};
  // extra — значения, которые добавятся в справочники при загрузке сводки (предпросмотр).
  const dv = (key: DictKey) => (extra && extra[key] ? dictValues(key).concat(extra[key] as string[]) : dictValues(key));
  const errors: Record<string, string> = {};
  const v: AlarmValues = {};

  const longText = (key: string, required: boolean, requiredMsg?: string) => {
    const t = text(b[key]);
    if (required && !t) errors[key] = requiredMsg || 'Заполните поле';
    else if (t && t.length > TEXT_MAX) errors[key] = `Не длиннее ${TEXT_MAX} символов (сейчас ${t.length})`;
    v[key] = t;
  };
  const pick = (key: string, list: string[], msg: string, required = true) => {
    const t = text(b[key]);
    if (!t) {
      if (required) errors[key] = msg;
      v[key] = null;
    } else if (list.indexOf(t) < 0) {
      errors[key] = 'Выберите значение из списка';
      v[key] = null;
    } else v[key] = t;
  };

  longText('PW', false);
  pick('NAPR', dv('napr'), 'Выберите направление');
  // Для «Вся сеть» ТЦ не указывается (ответ куратора, вопрос 8).
  if (v.NAPR === WHOLE_NETWORK) v.TEHC = null;
  else pick('TEHC', dv('tehc'), 'Выберите ТЦ');

  const kateg = parseInt(str(b.KATEG), 10);
  if (CATEGORIES.indexOf(kateg) < 0) errors.KATEG = 'Выберите категорию 1, 2 или 3';
  v.KATEG = isNaN(kateg) ? null : kateg;

  pick('NETW_TYPE', dv('netw'), 'Выберите тип сети');
  longText('SERV_ELEM', true, 'Укажите адрес БС или услугу');

  const bsRaw = str(b.NUMB_RBS);
  const bs = normalizeBs(bsRaw);
  if (bsRaw === '') errors.NUMB_RBS = `Укажите количество БС или «${SECTOR_LABEL}»`;
  else if (bs === null) errors.NUMB_RBS = `Целое число от 1 до ${MAX_BS} или «${SECTOR_LABEL}» (сектор)`;
  v.NUMB_RBS = bs;

  longText('EQIP_TYPE', false);
  pick('ALARM_TYPE', dv('type'), 'Выберите тип');
  longText('DESCR', false);

  // Аварии уже произошли — даты в будущем недопустимы (ответ куратора, вопрос 10).
  const latestMs = (parseDateTime(now) as number) + FUTURE_TOLERANCE_MS;
  const beginMs = parseDateTime(str(b.BEGIN_TIME));
  if (beginMs === null) errors.BEGIN_TIME = 'Укажите дату и время начала';
  else if (beginMs > latestMs) errors.BEGIN_TIME = 'Начало не может быть в будущем: вносятся только произошедшие аварии';
  v.BEGIN_TIME = beginMs === null ? null : formatDateTime(beginMs);

  const endRaw = str(b.END_TIME);
  if (endRaw === '' || endRaw.toUpperCase() === OPEN_END_LABEL || isOpenEnd(endRaw)) {
    v.END_TIME = ZERO_DATETIME;
  } else {
    const endMs = parseDateTime(endRaw);
    if (endMs === null) errors.END_TIME = 'Некорректная дата окончания';
    else if (beginMs !== null && endMs < beginMs) errors.END_TIME = 'Окончание раньше начала';
    else if (endMs > latestMs) errors.END_TIME = 'Окончание не может быть в будущем. Если авария продолжается — отметьте НВ';
    v.END_TIME = endMs === null ? null : formatDateTime(endMs);
  }

  const duration = (key: string) => {
    const raw = str(b[key]);
    if (!raw) {
      v[key] = null;
      return null;
    }
    const sec = parseDuration(raw);
    if (sec === null) errors[key] = 'Формат чч:мм:сс (можно чч.мм.сс)';
    else if (sec > TIME_MAX_SECONDS) errors[key] = 'Не больше 838:59:59';
    v[key] = sec === null ? null : formatDuration(sec);
    return sec;
  };
  duration('AKB');
  duration('DGU');
  const prostoySec = duration('PROSTOY');

  longText('ALARM_WHO', false);
  longText('DESC_NOTICE', false);

  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте выделенные поля', errors);

  // Автоматические поля.
  const len = computeLengthSeconds(v.BEGIN_TIME as string, v.END_TIME as string, now);
  v.LENGHT = len === null ? null : formatDuration(Math.max(0, len));
  // Точное значение без предела типа TIME (ответ куратора, вопрос 3): столбец текстовый.
  const common = computeCommonSeconds(prostoySec, v.NUMB_RBS as string);
  v.COMMON_PROSTOY = common === null ? null : formatDuration(common);
  return v;
}

// ---------------------------------------------------------------- представление строки

export function rowToApi(r: any, now: string) {
  const open = isOpenEnd(r.END_TIME);
  const lenSec = computeLengthSeconds(r.BEGIN_TIME, r.END_TIME, now);
  const prostoySec = sqlTimeToSeconds(r.PROSTOY);
  const commonSec =
    prostoySec !== null ? computeCommonSeconds(prostoySec, r.NUMB_RBS) : sqlTimeToSeconds(r.COMMON_PROSTOY);
  const bs: string | null = r.NUMB_RBS === null || r.NUMB_RBS === undefined ? null : formatBs(r.NUMB_RBS);
  return {
    ID: r.ID,
    PW: r.PW,
    NAPR: r.NAPR,
    TEHC: r.TEHC,
    KATEG: r.KATEG,
    NETW_TYPE: r.NETW_TYPE,
    SERV_ELEM: r.SERV_ELEM,
    NUMB_RBS: bs,
    EQIP_TYPE: r.EQIP_TYPE,
    ALARM_TYPE: r.ALARM_TYPE,
    DESCR: r.DESCR,
    BEGIN_TIME: r.BEGIN_TIME,
    END_TIME: open ? null : r.END_TIME,
    IS_OPEN: open,
    AKB: r.AKB,
    DGU: r.DGU,
    LENGHT: lenSec === null ? r.LENGHT : formatDuration(Math.max(0, lenSec)),
    LENGTH_SEC: lenSec === null ? null : Math.max(0, lenSec),
    PROSTOY: r.PROSTOY,
    COMMON_PROSTOY: commonSec === null ? null : formatDuration(commonSec),
    COMMON_SEC: commonSec,
    ALARM_WHO: r.ALARM_WHO,
    DESC_NOTICE: r.DESC_NOTICE,
  };
}

export type ApiAlarm = ReturnType<typeof rowToApi>;

// ---------------------------------------------------------------- фильтры

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

export function buildFilter(q: Request['query']) {
  const where: string[] = [];
  const params: unknown[] = [];
  const from = str(q.from);
  const to = str(q.to);
  const mode = str(q.mode) === 'active' ? 'active' : 'begin';
  const fromDt = DATE_RE.test(from) ? from + ' 00:00:00' : null;
  const toDt = DATE_RE.test(to) ? addDays(to, 1) + ' 00:00:00' : null;

  if (mode === 'begin') {
    if (fromDt) {
      where.push('BEGIN_TIME >= ?');
      params.push(fromDt);
    }
    if (toDt) {
      where.push('BEGIN_TIME < ?');
      params.push(toDt);
    }
  } else {
    // Действовавшие в периоде: начались до конца периода и не закончились до его начала.
    if (toDt) {
      where.push('BEGIN_TIME < ?');
      params.push(toDt);
    }
    if (fromDt) {
      where.push(`(${OPEN_COND} OR END_TIME >= ?)`);
      params.push(fromDt);
    }
  }

  const eq = (param: string, col: string) => {
    const val = str(q[param]);
    if (val) {
      where.push(`${col} = ?`);
      params.push(val);
    }
  };
  eq('napr', 'NAPR');
  eq('tehc', 'TEHC');
  eq('kateg', 'KATEG');
  eq('netw', 'NETW_TYPE');
  eq('type', 'ALARM_TYPE');

  const status = str(q.status);
  if (status === 'open') where.push(OPEN_COND);
  if (status === 'closed') where.push(`NOT ${OPEN_COND}`);

  const search = str(q.q);
  if (search) {
    where.push("CONCAT_WS(' ', PW, SERV_ELEM, EQIP_TYPE, DESCR, ALARM_WHO, DESC_NOTICE) LIKE ?");
    params.push('%' + escapeLike(search) + '%');
  }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function orderBy(q: Request['query'], now: string): string {
  const sorts: Record<string, string> = {
    id: 'ID',
    begin: 'BEGIN_TIME',
    end: `IF(${OPEN_COND}, '9999-12-31 00:00:00', END_TIME)`,
    pw: 'PW',
    napr: 'NAPR',
    tehc: 'TEHC',
    kateg: 'KATEG',
    netw: 'NETW_TYPE',
    type: 'ALARM_TYPE',
    bs: BS_NUM + ' {dir}, NUMB_RBS',
    length: lengthExpr(now),
    common: COMMON_EXPR,
  };
  const key = str(q.sort);
  const dir = str(q.dir) === 'asc' ? 'ASC' : 'DESC';
  const col = (sorts[key] || 'BEGIN_TIME').split('{dir}').join(dir);
  return `ORDER BY ${col} ${dir}, ID ${dir}`;
}

// ---------------------------------------------------------------- CSV

const CSV_SEPARATORS: Record<string, string> = { semicolon: ';', comma: ',', tab: '\t', pipe: '|' };

function csvCell(value: unknown, sep: string, isText: boolean): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Защита от формул в Excel/LibreOffice для текстовых полей.
  if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.indexOf(sep) >= 0 || /["\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const TEXT_FIELDS = ['PW', 'SERV_ELEM', 'EQIP_TYPE', 'DESCR', 'ALARM_WHO', 'DESC_NOTICE'];

export function alarmsToCsv(items: ApiAlarm[], sepKey: string): string {
  const sep = CSV_SEPARATORS[sepKey] || ';';
  const header = ['№', ...FIELDS.map((f) => f.label)];
  const lines = [header.map((h) => csvCell(h, sep, false)).join(sep)];
  for (const a of items) {
    const cells: unknown[] = [a.ID];
    for (const f of FIELDS) {
      const k = f.key;
      let val: unknown = (a as any)[k];
      if (k === 'BEGIN_TIME') val = humanDateTime(a.BEGIN_TIME, true);
      else if (k === 'END_TIME') val = a.IS_OPEN ? OPEN_END_LABEL : humanDateTime(a.END_TIME, true);
      cells.push(csvCell(val, sep, TEXT_FIELDS.indexOf(k) >= 0));
    }
    lines.push(cells.map((c) => String(c)).join(sep));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- запись и аудит

async function getRow(id: number): Promise<any> {
  const rows = await select('SELECT * FROM alarms WHERE ID = ?', [id]);
  if (!rows[0]) throw new HttpError(404, `Авария №${id} не найдена — возможно, её удалили`);
  return rows[0];
}

export function diff(before: any, after: AlarmValues) {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of COLUMNS) {
    if (k === 'LENGHT') continue; // меняется сама по себе для НВ
    const a = before[k] === undefined ? null : before[k];
    const b = after[k] === undefined ? null : after[k];
    if (String(a ?? '') !== String(b ?? '')) changes[k] = [a, b];
  }
  return changes;
}

/**
 * Раз в минуту: обновляет LENGHT у открытых (НВ) аварий, чтобы и прямые выборки из БД видели
 * актуальную длительность (ответ куратора, вопрос 4), и проверяет эскалацию долгих аварий.
 */
export async function tickOpenAlarms(): Promise<void> {
  const now = nowWall();
  const rows = await select(`SELECT * FROM alarms WHERE ${OPEN_COND} AND BEGIN_TIME IS NOT NULL`);
  for (const r of rows) {
    const len = computeLengthSeconds(r.BEGIN_TIME, null, now);
    if (len !== null) await exec('UPDATE alarms SET LENGHT = ? WHERE ID = ?', [formatDuration(Math.max(0, len)), r.ID]);
  }
  await checkLongAlarms(rows.map((r) => rowToApi(r, now)));
}

// ---------------------------------------------------------------- маршруты

export const alarmsRouter = Router();

/** Открытые аварии (окончание = НВ) — для табло на вкладке «Аварии». */
alarmsRouter.get('/open', requireAuth, async (_req, res) => {
  const now = nowWall();
  const rows = await select(`SELECT * FROM alarms WHERE ${OPEN_COND} ORDER BY BEGIN_TIME ASC, ID ASC LIMIT 500`);
  // Данные станции из инвентаря: автономность АКБ и ДГУ — для прогноза разряда на табло.
  const stations = await stationsForElems(rows.map((r) => r.SERV_ELEM));
  const items = rows.map((r) => {
    const st = r.SERV_ELEM ? stations.get(r.SERV_ELEM) : undefined;
    return Object.assign(rowToApi(r, now), {
      STATION: st ? { id: st.id, code: st.code, akb_minutes: st.akb_minutes, has_dgu: st.has_dgu } : null,
    });
  });
  res.json({ items, serverNow: now });
});

/** Подсказки для полей ввода по ранее внесённым значениям. */
alarmsRouter.get('/suggest', requireAuth, async (req, res) => {
  const allowed = ['SERV_ELEM', 'EQIP_TYPE', 'ALARM_WHO', 'DESCR'];
  const field = str(req.query.field);
  if (allowed.indexOf(field) < 0) throw new HttpError(400, 'Неизвестное поле');
  const q = str(req.query.q);
  // Описание — самые частые для выбранного типа аварии; «кому» — люди того же ТЦ.
  const extra: string[] = [];
  const params: unknown[] = ['%' + escapeLike(q) + '%'];
  const type = str(req.query.type);
  if (type && field === 'DESCR') {
    extra.push('ALARM_TYPE = ?');
    params.push(type);
  }
  const tehc = str(req.query.tehc);
  if (tehc && field === 'ALARM_WHO') {
    extra.push('TEHC = ?');
    params.push(tehc);
  }
  const order = field === 'DESCR' ? 'COUNT(*) DESC, MAX(ID) DESC' : 'MAX(ID) DESC';
  const rows = await select(
    `SELECT ${field} AS v FROM alarms WHERE ${field} IS NOT NULL AND ${field} <> '' AND ${field} LIKE ?${extra.length ? ' AND ' + extra.join(' AND ') : ''}
     GROUP BY ${field} ORDER BY ${order} LIMIT 15`,
    params,
  );
  res.json({ items: rows.map((r) => r.v) });
});

/** Выгрузка в CSV за период (с теми же фильтрами, что и список). */
alarmsRouter.get('/export.csv', requireAuth, async (req, res) => {
  const now = nowWall();
  const { whereSql, params } = buildFilter(req.query);
  const rows = await select(`SELECT * FROM alarms ${whereSql} ORDER BY BEGIN_TIME ASC, ID ASC LIMIT 200000`, params);
  const csv = alarmsToCsv(rows.map((r) => rowToApi(r, now)), str(req.query.sep));
  const from = str(req.query.from) || 'start';
  const to = str(req.query.to) || now.slice(0, 10);
  const name = `avarii_${from}_${to}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(csv);
});

/** Список за период: пагинация, сортировка, итоги по всей выборке. */
alarmsRouter.get('/', requireAuth, async (req, res) => {
  const now = nowWall();
  const { whereSql, params } = buildFilter(req.query);
  const pageSize = intParam(req.query.pageSize, 50, 5, 500);
  const page = intParam(req.query.page, 1, 1, 1000000);
  const rows = await select(
    `SELECT * FROM alarms ${whereSql} ${orderBy(req.query, now)} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  const [t] = await select(
    `SELECT COUNT(*) AS cnt,
            SUM(IF(${OPEN_COND}, 1, 0)) AS open_cnt,
            SUM(GREATEST(0, ${lengthExpr(now)})) AS length_sec,
            SUM(${COMMON_EXPR}) AS common_sec,
            SUM(${BS_NUM}) AS bs_sum,
            SUM(IF(NUMB_RBS = '${SECTOR_LABEL}', 1, 0)) AS sector_cnt,
            SUM(TIME_TO_SEC(AKB)) AS akb_sec,
            SUM(TIME_TO_SEC(DGU)) AS dgu_sec
       FROM alarms ${whereSql}`,
    params,
  );
  res.json({
    items: rows.map((r) => rowToApi(r, now)),
    total: Number(t.cnt) || 0,
    page,
    pageSize,
    totals: {
      count: Number(t.cnt) || 0,
      open: Number(t.open_cnt) || 0,
      lengthSec: Number(t.length_sec) || 0,
      commonSec: Number(t.common_sec) || 0,
      bs: Number(t.bs_sum) || 0,
      sectors: Number(t.sector_cnt) || 0,
      akbSec: Number(t.akb_sec) || 0,
      dguSec: Number(t.dgu_sec) || 0,
    },
    serverNow: now,
  });
});

alarmsRouter.get('/:id', requireAuth, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const row = await getRow(id);
  res.json({ item: rowToApi(row, nowWall()) });
});

alarmsRouter.post('/', requireEditor, async (req, res) => {
  const now = nowWall();
  const v = validateAlarm(req.body, now);
  const cols = COLUMNS.filter((c) => c in v);
  const result = await exec(
    `INSERT INTO alarms (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => v[c]),
  );
  const id = result.insertId;
  await logAction(req.user!, 'alarm_create', id, v);
  const item = rowToApi(await getRow(id), now);
  res.status(201).json({ item });
  rememberOrigin(req);
  void notifyAlarm('create', item, req.user!);
});

alarmsRouter.put('/:id', requireEditor, async (req, res) => {
  const now = nowWall();
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const before = await getRow(id);
  const v = validateAlarm(req.body, now);
  const changes = diff(before, v);
  const cols = COLUMNS.filter((c) => c in v);
  await exec(`UPDATE alarms SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE ID = ?`, [
    ...cols.map((c) => v[c]),
    id,
  ]);
  if (Object.keys(changes).length) await logAction(req.user!, 'alarm_update', id, changes);
  const item = rowToApi(await getRow(id), now);
  res.json({ item });
  // Закрытие через редактирование (НВ → дата) — то же событие, что и кнопка «Закрыть».
  if (isOpenEnd(before.END_TIME) && !item.IS_OPEN) {
    rememberOrigin(req);
    void notifyAlarm('close', item, req.user!);
  }
});

/** Быстрое закрытие аварии: окончание = указанное время или «сейчас». */
alarmsRouter.post('/:id/close', requireEditor, async (req, res) => {
  const now = nowWall();
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const row = await getRow(id);
  if (!isOpenEnd(row.END_TIME)) throw new HttpError(409, `Авария №${id} уже закрыта`);
  const raw = str(req.body?.END_TIME);
  const endMs = raw ? parseDateTime(raw) : parseDateTime(now.slice(0, 16) + ':00');
  if (endMs === null) throw new HttpError(400, 'Некорректная дата окончания', { END_TIME: 'Некорректная дата' });
  if (endMs > (parseDateTime(now) as number) + FUTURE_TOLERANCE_MS) {
    throw new HttpError(400, 'Окончание не может быть в будущем', { END_TIME: 'Окончание не может быть в будущем' });
  }
  const end = formatDateTime(endMs);
  const beginMs = parseDateTime(row.BEGIN_TIME);
  if (beginMs !== null && endMs < beginMs) {
    throw new HttpError(400, 'Окончание раньше начала', { END_TIME: 'Окончание раньше начала' });
  }
  const len = computeLengthSeconds(row.BEGIN_TIME, end, now);
  const lenght = len === null ? null : formatDuration(Math.max(0, len));
  await exec('UPDATE alarms SET END_TIME = ?, LENGHT = ? WHERE ID = ?', [end, lenght, id]);
  await logAction(req.user!, 'alarm_close', id, { END_TIME: [OPEN_END_LABEL, end], LENGHT: [row.LENGHT, lenght] });
  const item = rowToApi(await getRow(id), now);
  res.json({ item });
  rememberOrigin(req);
  void notifyAlarm('close', item, req.user!);
});

/** Удаление — в корзину: запись переносится в alarms_deleted и может быть восстановлена. */
alarmsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const row = await getRow(id);
  const cols = ['ID', ...COLUMNS];
  await exec('DELETE FROM alarms_deleted WHERE ID = ?', [id]);
  await exec(
    `INSERT INTO alarms_deleted (${cols.join(', ')}, deleted_at, deleted_by) SELECT ${cols.join(', ')}, ?, ? FROM alarms WHERE ID = ?`,
    [nowWall(), req.user!.full_name || req.user!.login, id],
  );
  await exec('DELETE FROM alarms WHERE ID = ?', [id]);
  const snapshot: Record<string, unknown> = {};
  for (const c of COLUMNS) snapshot[c] = row[c];
  await logAction(req.user!, 'alarm_delete', id, snapshot);
  res.json({ ok: true });
});

/** Корзина: удалённые аварии (только администратор). */
alarmsRouter.get('/trash/list', requireAdmin, async (req, res) => {
  const now = nowWall();
  const q = str(req.query.q);
  const where = q ? "WHERE CONCAT_WS(' ', PW, SERV_ELEM, DESCR, DESC_NOTICE) LIKE ?" : '';
  const rows = await select(`SELECT * FROM alarms_deleted ${where} ORDER BY deleted_at DESC LIMIT 500`, q ? ['%' + escapeLike(q) + '%'] : []);
  res.json({ items: rows.map((r) => Object.assign(rowToApi(r, now), { deleted_at: r.deleted_at, deleted_by: r.deleted_by })) });
});

/** Восстановить из корзины: с прежним номером, если он свободен. */
alarmsRouter.post('/trash/:id/restore', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [row] = await select('SELECT * FROM alarms_deleted WHERE ID = ?', [id]);
  if (!row) throw new HttpError(404, 'В корзине нет аварии №' + id);
  const [busy] = await select('SELECT ID FROM alarms WHERE ID = ?', [id]);
  const cols = busy ? COLUMNS.slice() : ['ID', ...COLUMNS];
  const r = await exec(`INSERT INTO alarms (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM alarms_deleted WHERE ID = ?`, [id]);
  const newId = busy ? r.insertId : id;
  await exec('DELETE FROM alarms_deleted WHERE ID = ?', [id]);
  await logAction(req.user!, 'alarm_restore', newId, { from: id });
  res.json({ ok: true, id: newId });
});

/** Удалить из корзины навсегда. */
alarmsRouter.delete('/trash/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [row] = await select('SELECT ID, SERV_ELEM FROM alarms_deleted WHERE ID = ?', [id]);
  if (!row) throw new HttpError(404, 'В корзине нет аварии №' + id);
  await exec('DELETE FROM alarms_deleted WHERE ID = ?', [id]);
  await logAction(req.user!, 'alarm_purge', id, { SERV_ELEM: row.SERV_ELEM });
  res.json({ ok: true });
});
