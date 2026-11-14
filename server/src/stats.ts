import { Router } from 'express';
import { select } from './db.js';
import { nowWall } from './clock.js';
import { requireAuth } from './auth.js';
import { buildFilter, rowToApi, type ApiAlarm } from './alarms.js';
import { dictValues } from './dicts.js';
import { str } from './http.js';
import { CATEGORIES, bsCount, elemKey, isSector, stationCodeOf } from '../../shared/dict.js';
import { addDays, parseDateTime, sqlTimeToSeconds } from '../../shared/time.js';

interface Bucket {
  key: string;
  count: number;
  open: number;
  lengthSec: number;
  commonSec: number;
  bs: number;
  /** Средняя длительность закрытых аварий (MTTR). */
  avgSec: number;
  closed: number;
  closedLengthSec: number;
}

function emptyBucket(key: string): Bucket {
  return { key, count: 0, open: 0, lengthSec: 0, commonSec: 0, bs: 0, avgSec: 0, closed: 0, closedLengthSec: 0 };
}

function group(items: ApiAlarm[], keyOf: (a: ApiAlarm) => string, order: string[]): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const k of order) map.set(k, emptyBucket(k));
  for (const a of items) {
    const k = keyOf(a) || '—';
    let b = map.get(k);
    if (!b) {
      b = emptyBucket(k);
      map.set(k, b);
    }
    b.count++;
    if (a.IS_OPEN) b.open++;
    else {
      b.closed++;
      b.closedLengthSec += a.LENGTH_SEC || 0;
    }
    b.lengthSec += a.LENGTH_SEC || 0;
    b.commonSec += a.COMMON_SEC || 0;
    b.bs += bsCount(a.NUMB_RBS);
  }
  const out = Array.from(map.values());
  for (const b of out) b.avgSec = b.closed ? Math.round(b.closedLengthSec / b.closed) : 0;
  return out;
}

function totalsOf(items: ApiAlarm[]) {
  const closed = items.filter((a) => !a.IS_OPEN && a.LENGTH_SEC !== null);
  const t = {
    count: items.length,
    open: 0,
    closed: closed.length,
    lengthSec: 0,
    commonSec: 0,
    bs: 0,
    sectors: 0,
    akbSec: 0,
    dguSec: 0,
    avgClosedSec: 0,
    maxLengthSec: 0,
    cat1: 0,
  };
  for (const a of items) {
    if (a.IS_OPEN) t.open++;
    t.lengthSec += a.LENGTH_SEC || 0;
    t.commonSec += a.COMMON_SEC || 0;
    if (isSector(a.NUMB_RBS)) t.sectors++;
    else t.bs += bsCount(a.NUMB_RBS);
    t.akbSec += sqlTimeToSeconds(a.AKB) || 0;
    t.dguSec += sqlTimeToSeconds(a.DGU) || 0;
    if ((a.LENGTH_SEC || 0) > t.maxLengthSec) t.maxLengthSec = a.LENGTH_SEC || 0;
    if (a.KATEG === 1) t.cat1++;
  }
  t.avgClosedSec = closed.length ? Math.round(closed.reduce((s, a) => s + (a.LENGTH_SEC || 0), 0) / closed.length) : 0;
  return t;
}

async function loadItems(query: Record<string, unknown>, now: string): Promise<ApiAlarm[]> {
  const { whereSql, params } = buildFilter(query as any);
  const rows = await select(`SELECT * FROM alarms ${whereSql} ORDER BY BEGIN_TIME ASC LIMIT 100000`, params);
  return rows.map((r) => rowToApi(r, now));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const statsRouter = Router();

statsRouter.get('/', requireAuth, async (req, res) => {
  const now = nowWall();
  const items = await loadItems(req.query, now);
  const totals = totalsOf(items);

  // Тот же отбор за предыдущий период такой же длины — для сравнения «стало лучше или хуже».
  let from = str(req.query.from);
  let to = str(req.query.to);
  let prev: (ReturnType<typeof totalsOf> & { from: string; to: string }) | null = null;
  if (DATE_RE.test(from) && DATE_RE.test(to) && from <= to) {
    const days = Math.round(((parseDateTime(to + ' 00:00:00') as number) - (parseDateTime(from + ' 00:00:00') as number)) / 86400000) + 1;
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(from, -days);
    const prevItems = await loadItems(Object.assign({}, req.query, { from: prevFrom, to: prevTo }), now);
    prev = Object.assign(totalsOf(prevItems), { from: prevFrom, to: prevTo });
  }

  // По дням (по дате начала). Без заданного периода — от первой до последней аварии.
  if (!DATE_RE.test(from)) from = items.length ? String(items[0].BEGIN_TIME).slice(0, 10) : now.slice(0, 10);
  if (!DATE_RE.test(to)) to = now.slice(0, 10);
  const days: Array<{ date: string; count: number; commonSec: number; lengthSec: number }> = [];
  const dayIndex = new Map<string, number>();
  for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i++) {
    dayIndex.set(d, days.length);
    days.push({ date: d, count: 0, commonSec: 0, lengthSec: 0 });
  }
  for (const a of items) {
    const idx = dayIndex.get(String(a.BEGIN_TIME).slice(0, 10));
    if (idx === undefined) continue;
    days[idx].count++;
    days[idx].commonSec += a.COMMON_SEC || 0;
    days[idx].lengthSec += a.LENGTH_SEC || 0;
  }

  // Матрица «ТЦ × тип аварии»: где и какие аварии случаются (ответ куратора, вопрос 15).
  const types = group(items, (a) => a.ALARM_TYPE || '', dictValues('type', true)).filter((b) => b.count > 0).map((b) => b.key);
  const tehcs = group(items, (a) => a.TEHC || 'Без ТЦ', dictValues('tehc', true)).filter((b) => b.count > 0)
    .sort((x, y) => y.count - x.count).map((b) => b.key);
  const cells = tehcs.map(() => types.map(() => ({ count: 0, commonSec: 0 })));
  for (const a of items) {
    const r = tehcs.indexOf(a.TEHC || 'Без ТЦ');
    const c = types.indexOf(a.ALARM_TYPE || '');
    if (r < 0 || c < 0) continue;
    cells[r][c].count++;
    cells[r][c].commonSec += a.COMMON_SEC || 0;
  }

  // Повторяющиеся аварии на одной станции — кандидаты на профилактику.
  const byStation = new Map<string, { key: string; code: string | null; servElem: string; count: number; lengthSec: number; commonSec: number; last: string; types: Record<string, number> }>();
  for (const a of items) {
    if (!a.SERV_ELEM || a.NAPR === 'Вся сеть') continue;
    // Ключ — вся строка «код — название»: в обезличенной сводке один код бывает у разных объектов.
    const code = stationCodeOf(a.SERV_ELEM);
    const key = elemKey(a.SERV_ELEM);
    let s = byStation.get(key);
    if (!s) {
      s = { key, code, servElem: a.SERV_ELEM, count: 0, lengthSec: 0, commonSec: 0, last: '', types: {} };
      byStation.set(key, s);
    }
    s.count++;
    s.lengthSec += a.LENGTH_SEC || 0;
    s.commonSec += a.COMMON_SEC || 0;
    if (String(a.BEGIN_TIME) > s.last) {
      s.last = String(a.BEGIN_TIME);
      s.servElem = a.SERV_ELEM;
    }
    const t = a.ALARM_TYPE || '—';
    s.types[t] = (s.types[t] || 0) + 1;
  }
  const repeat = Array.from(byStation.values())
    .filter((s) => s.count >= 2)
    .sort((x, y) => y.count - x.count || y.commonSec - x.commonSec)
    .slice(0, 10);

  const top = items
    .slice()
    .sort((x, y) => (y.COMMON_SEC || 0) - (x.COMMON_SEC || 0) || (y.LENGTH_SEC || 0) - (x.LENGTH_SEC || 0))
    .slice(0, 10);

  res.json({
    totals,
    prev,
    byNapr: group(items, (a) => a.NAPR || '', dictValues('napr', true)),
    byTehc: group(items, (a) => a.TEHC || 'Без ТЦ', dictValues('tehc', true)).filter((b) => b.count > 0),
    byType: group(items, (a) => a.ALARM_TYPE || '', dictValues('type', true)),
    byKateg: group(items, (a) => (a.KATEG ? String(a.KATEG) : ''), CATEGORIES.map(String)),
    byNetw: group(items, (a) => a.NETW_TYPE || '', dictValues('netw', true)),
    byDay: days,
    matrix: { rows: tehcs, cols: types, cells },
    repeat,
    top,
    serverNow: now,
  });
});
