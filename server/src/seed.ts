import fs from 'node:fs';
import { exec, select, stationKey } from './db.js';
import { nowWall } from './clock.js';
import { hashPassword } from './auth.js';
import { config } from './config.js';
import { SECTOR_LABEL, formatElem, stationCodeOf } from '../../shared/dict.js';
import {
  ZERO_DATETIME, computeCommonSeconds, estimateProstoySeconds, formatDateTime, formatDuration, parseDateTime,
} from '../../shared/time.js';

/** Создаёт администратора, если в системе нет ни одного пользователя (и демо-пользователей в демо-режиме). */
export async function ensureUsers(): Promise<void> {
  const [{ c }] = await select<{ c: number }>('SELECT COUNT(*) AS c FROM users');
  if (Number(c) > 0) return;
  const now = nowWall();
  const users: Array<[string, string, string, string]> = [
    [config.adminLogin, 'Администратор системы', 'admin', config.adminPassword],
  ];
  if (config.seedDemo) {
    users.push(['duty', 'Дежурный ЦОУ (демо)', 'duty', 'duty']);
    users.push(['engineer', 'Инженер ТЦ (демо)', 'engineer', 'engineer']);
  }
  for (const [login, name, role, pw] of users) {
    await exec(
      'INSERT INTO users (login, full_name, role, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      [login, name, role, await hashPassword(pw), now],
    );
    console.log(`[seed] создан пользователь ${login} (${role})`);
  }
}

// ================================================================ демо-данные
//
// Основа — обезличенная сводка ЦОУ (db/demo/summary-cc.json, лист «Аварии на сети СС»):
// её 231 строка ложится в последние сутки демо-базы (даты сдвигаются на целое число суток,
// чтобы время суток не менялось). Вокруг генерируется история за 60 дней в том же стиле:
// те же объекты и формат «код — название», описания и примечания по типам, исполнители по ТЦ.
// Время — как в жизни: суточный ритм по типам аварий, утренние находки в 08:00, грозовые дни
// с волной отключений электропитания в нескольких ТЦ направления, длительность по типу аварии.

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type R = () => number;

function pickW<T>(r: R, items: Array<[T, number]>): T {
  const total = items.reduce((s, x) => s + x[1], 0);
  let x = r() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x <= 0) return v;
  }
  return items[items.length - 1][0];
}

function pick<T>(r: R, items: T[]): T {
  return items[Math.floor(r() * items.length)];
}

/** Нормальное распределение (Бокс — Мюллер). */
function gauss(r: R): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

/** Логнормальная длительность в секундах: медиана в минутах, разброс sigma. */
function lognormal(r: R, medianMin: number, sigma: number): number {
  return Math.round(medianMin * 60 * Math.exp(sigma * gauss(r)));
}

/** Поле «кому» однострочное — переносы из ячеек Excel заменяем пробелом. */
function oneLine(s: string | null | undefined): string {
  return String(s || '').replace(/\s*\n\s*/g, ' ').trim();
}

function weightsOf(values: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) || 0) + 1);
  return Array.from(m.entries());
}

interface SummaryRow {
  PW: string;
  NAPR: string;
  TEHC: string;
  KATEG: number;
  NETW_TYPE: string;
  SERV_ELEM: string;
  NUMB_RBS: string;
  EQIP_TYPE: string;
  ALARM_TYPE: string;
  DESCR: string;
  BEGIN_TIME: string;
  END_TIME: string | null;
  AKB_SEC: number | null;
  DGU_SEC: number | null;
  PROSTOY_SEC: number | null;
  ALARM_WHO: string;
  DESC_NOTICE: string;
}

function loadSummary(): { fileNow: string; rows: SummaryRow[] } | null {
  const file = config.demoFile;
  if (!file || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cols: string[] = data.columns;
  const rows = (data.rows as unknown[][]).map((a) => {
    const o: any = {};
    cols.forEach((c, i) => (o[c] = a[i]));
    return o as SummaryRow;
  });
  return { fileNow: data.fileNow, rows };
}

// Запасной словарь — если файла сводки нет.
const FALLBACK: SummaryRow[] = [
  { PW: '', NAPR: 'ЮЗН', TEHC: 'ЕКБ', KATEG: 3, NETW_TYPE: 'GSM LTE', SERV_ELEM: 'EK_A01 — Базовая станция «Северный-001»', NUMB_RBS: '1', EQIP_TYPE: '6630', ALARM_TYPE: 'ЭЛ', DESCR: 'Аварийное отключение промсети', BEGIN_TIME: '', END_TIME: null, AKB_SEC: null, DGU_SEC: null, PROSTOY_SEC: 0, ALARM_WHO: 'Начальнику ТЦ (при получении сводки)', DESC_NOTICE: 'Выезд не планировался.' },
  { PW: '', NAPR: 'СВН', TEHC: 'АСБ', KATEG: 3, NETW_TYPE: 'GSM LTE', SERV_ELEM: 'AS_B02 — Базовая станция «Лесной-002»', NUMB_RBS: '1', EQIP_TYPE: '5216', ALARM_TYPE: 'RBS', DESCR: 'Аппаратная неисправность', BEGIN_TIME: '', END_TIME: null, AKB_SEC: null, DGU_SEC: null, PROSTOY_SEC: 0, ALARM_WHO: 'Начальнику ТЦ (при получении сводки)', DESC_NOTICE: 'Требуется замена RRU.' },
];

const ADJECTIVES = ['Северный', 'Восточный', 'Кедровый', 'Высокий', 'Радужный', 'Полевой', 'Янтарный', 'Приозёрный', 'Заречный', 'Таёжный',
  'Речной', 'Сосновый', 'Каменный', 'Степной', 'Солнечный', 'Озерный', 'Береговой', 'Лесной', 'Луговой', 'Южный', 'Горный', 'Ключевой'];
const RBS_MODELS: Array<[string, number]> = [['5216', 30], ['6630', 26], ['6601', 18], ['6201', 6], ['6301', 3], ['6602', 2]];
const NETW_W: Array<[string, number]> = [['GSM LTE', 90], ['LTE', 8], ['GSM', 2]];

interface SeedStation {
  code: string;
  name: string;
  napr: string;
  tehc: string;
  netw: string;
  eq: string;
  bs: number;
  akbMin: number | null;
  dgu: boolean;
  elem: string;
}

/** Длительность по типу и описанию аварии (логнормально), секунды. */
function durationFor(r: R, type: string, descr: string, storm: boolean): number {
  const d = descr.toLowerCase();
  let sec: number;
  if (type === 'ЭЛ') sec = storm ? lognormal(r, 200, 0.8) : lognormal(r, 140, 1.0);
  else if (type === 'RBS') {
    if (/аппаратн/.test(d)) sec = lognormal(r, 22 * 60, 1.1);
    else if (/сектор/.test(d)) sec = lognormal(r, 95, 1.0);
    else sec = lognormal(r, 80, 1.1);
  } else if (type === 'ОПС') sec = lognormal(r, 18, 1.0);
  else if (type === 'ТМ') sec = lognormal(r, 9 * 60, 1.2);
  else if (type === 'РРЛ') sec = lognormal(r, 45, 1.0);
  else if (type === 'ДГУ') sec = lognormal(r, 5 * 60, 0.9);
  else if (type === 'ИБП') sec = lognormal(r, 4 * 60, 0.9);
  else if (type === 'ВОЛС') sec = lognormal(r, 7 * 60, 0.8);
  else sec = lognormal(r, 3 * 60, 0.8);
  return Math.min(15 * 86400, Math.max(120, Math.round(sec / 60) * 60));
}

/** Час начала по типу: электропитание — днём и вечером, ОПС — в рабочее время, ТМ — утренняя проверка в 08:00. */
function beginOfDay(r: R, type: string): { hour: number; minute: number } {
  const exact8 = (type === 'ТМ' && r() < 0.4) || (type === 'RBS' && r() < 0.1);
  if (exact8) return { hour: 8, minute: 0 };
  const hours: Record<string, number[]> = {
    ЭЛ: [2, 2, 1, 1, 1, 2, 3, 4, 5, 6, 6, 6, 7, 8, 9, 9, 9, 8, 7, 6, 5, 4, 3, 2],
    ОПС: [2, 1, 1, 1, 1, 2, 4, 7, 9, 9, 8, 8, 8, 8, 8, 8, 7, 6, 4, 3, 3, 2, 2, 2],
    РРЛ: [3, 3, 3, 3, 3, 3, 4, 4, 5, 5, 6, 7, 8, 8, 8, 7, 6, 5, 4, 4, 3, 3, 3, 3],
  };
  const w = hours[type] || [4, 3, 3, 3, 3, 3, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 5, 5, 5, 4, 4, 4];
  return { hour: pickW(r, w.map((x, i) => [i, x] as [number, number])), minute: Math.floor(r() * 60) };
}

/** Демо-данные: инвентарь, сводка ЦОУ за последние сутки и история за 60 дней, правила уведомлений. Только для пустой БД. */
export async function seedDemo(): Promise<void> {
  if (!config.seedDemo) return;
  const r = rng(20261114);
  const summary = loadSummary();
  const real = summary ? summary.rows : [];
  const vocab = real.length ? real : FALLBACK;

  // ---------------- словари из сводки
  const tcDir = new Map<string, string>();
  const tcWho = new Map<string, string[]>();
  for (const a of vocab) {
    if (a.TEHC && a.NAPR && !tcDir.has(a.TEHC)) tcDir.set(a.TEHC, a.NAPR);
    if (a.TEHC && a.ALARM_WHO) {
      const list = tcWho.get(a.TEHC) || [];
      list.push(a.ALARM_WHO);
      tcWho.set(a.TEHC, list);
    }
  }
  const byType = new Map<string, SummaryRow[]>();
  for (const a of vocab) {
    const list = byType.get(a.ALARM_TYPE) || [];
    list.push(a);
    byType.set(a.ALARM_TYPE, list);
  }
  const descrW = new Map<string, Array<[string, number]>>();
  const noticeOf = new Map<string, string[]>();
  for (const [t, list] of byType) {
    descrW.set(t, weightsOf(list.map((a) => a.DESCR)));
    noticeOf.set(t, list.map((a) => a.DESC_NOTICE).filter((x) => x && x.length < 260));
  }
  // Частоты типов как в сводке, но без редких одиночных (ПР, ВОЛС) — они остаются в строках сводки.
  const typeW: Array<[string, number]> = Array.from(byType.entries())
    .map(([t, l]) => [t, l.length] as [string, number])
    .filter(([, n]) => n >= 3);
  const kategW: Record<string, Array<[number, number]>> = {
    ЭЛ: [[1, 8], [2, 14], [3, 78]],
    RBS: [[1, 6], [2, 20], [3, 74]],
    ОПС: [[1, 30], [2, 10], [3, 60]],
    РРЛ: [[1, 20], [2, 30], [3, 50]],
  };

  // ---------------- инвентарь: объекты сводки + сгенерированные в том же формате
  const stations: SeedStation[] = [];
  const byElem = new Map<string, SeedStation>();
  const usedNums = new Set<string>();
  const usedCodes = new Set<string>();
  const usedKeys = new Set<string>();
  for (const a of vocab) {
    const code = stationCodeOf(a.SERV_ELEM);
    if (!code || byElem.has(a.SERV_ELEM)) continue;
    const name = a.SERV_ELEM.replace(/^\s*\S+\s*—\s*/, '');
    const key = stationKey(code, name);
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    const num = /-(\d{3})»/.exec(name);
    if (num) usedNums.add(num[1]);
    usedCodes.add(code);
    const own = vocab.filter((x) => x.SERV_ELEM === a.SERV_ELEM);
    const model = own.map((x) => x.EQIP_TYPE).find((e) => /^\d{4}$/.test(e));
    // Автономность АКБ: в сводке — время работы от АКБ, если после него БС всё же отключилась.
    const akbSeen = own.filter((x) => x.ALARM_TYPE === 'ЭЛ' && (x.AKB_SEC || 0) > 0 && (x.PROSTOY_SEC || 0) > 0).map((x) => x.AKB_SEC as number);
    const bsMax = Math.max(1, ...own.map((x) => (/^\d+$/.test(x.NUMB_RBS) ? Number(x.NUMB_RBS) : 1)));
    const st: SeedStation = {
      code, name, napr: a.NAPR, tehc: a.TEHC, netw: a.NETW_TYPE || 'GSM LTE',
      eq: model || pickW(r, RBS_MODELS), bs: bsMax,
      akbMin: akbSeen.length ? Math.max(10, Math.round(akbSeen[0] / 60)) : r() < 0.9 ? pick(r, [60, 90, 120, 180, 240, 300, 360]) : null,
      dgu: own.some((x) => (x.DGU_SEC || 0) > 0 || x.ALARM_TYPE === 'ДГУ') || r() < 0.08,
      elem: a.SERV_ELEM,
    };
    stations.push(st);
    byElem.set(st.elem, st);
  }
  const fromSummary = stations.length;
  const letters = Array.from(new Set(Array.from(usedCodes).map((c) => c.slice(0, 2)).filter((c) => /^[A-Z]{2}$/.test(c))));
  const pool = 'ABCDFGHJKLMNPQRSTVWXYZ0123456789';
  const tcs = Array.from(tcDir.keys());
  let nextNum = 1;
  for (const tehc of tcs) {
    const have = stations.filter((s) => s.tehc === tehc).length;
    const target = tehc === 'ЕКБ' ? 46 : 20 + Math.floor(r() * 10);
    for (let i = have; i < target; i++) {
      while (usedNums.has(String(nextNum).padStart(3, '0'))) nextNum++;
      const num = String(nextNum++).padStart(3, '0');
      usedNums.add(num);
      let code = '';
      do {
        code = (letters.length ? pick(r, letters) : 'BS') + '_' + pick(r, pool.split('')) + pick(r, pool.split('')) + pick(r, pool.split(''));
      } while (usedCodes.has(code));
      usedCodes.add(code);
      const name = `Базовая станция «${pick(r, ADJECTIVES)}-${num}»`;
      const st: SeedStation = {
        code, name, napr: tcDir.get(tehc) || 'ЮЗН', tehc, netw: pickW(r, NETW_W), eq: pickW(r, RBS_MODELS),
        bs: r() < 0.03 ? 7 : 1,
        akbMin: r() < 0.9 ? pick(r, [60, 90, 120, 180, 240, 300, 360, 480]) : null,
        dgu: r() < 0.1,
        elem: formatElem(code, name),
      };
      stations.push(st);
      byElem.set(st.elem, st);
    }
  }

  const [{ sc }] = await select<{ sc: number }>('SELECT COUNT(*) AS sc FROM stations');
  if (Number(sc) === 0) {
    const now = nowWall();
    const rows = stations.map((s) => [
      s.code, s.name, stationKey(s.code, s.name), s.napr, s.tehc, s.netw, s.eq, s.bs, s.akbMin, s.dgu ? 1 : 0, null, 1, now,
    ]);
    for (let i = 0; i < rows.length; i += 400) {
      await exec(
        `INSERT INTO stations (code, address, elem_key, napr, tehc, netw_type, eqip_type, bs_count, akb_minutes, has_dgu, note, is_active, updated_at) VALUES ?`,
        [rows.slice(i, i + 400)],
      );
    }
    console.log(`[seed] инвентарь: ${rows.length} объектов, из них ${fromSummary} — из сводки ЦОУ`);
  }

  const [{ rc }] = await select<{ rc: number }>('SELECT COUNT(*) AS rc FROM notify_rules');
  if (Number(rc) === 0) {
    const now = nowWall();
    await exec(
      `INSERT INTO notify_rules (name, channel, target, kateg, napr, tehc, alarm_types, on_create, on_close, long_hours, daily_at, is_active, created_at) VALUES ?`,
      [[
        ['Категория 1 — дежурная смена ЦОУ', 'email', 'cou-duty@example.local', '1', '', '', '', 1, 1, null, null, 1, now],
        ['Электропитание дольше 4 ч — энергетики', 'email', 'energy@example.local', '', '', '', 'ЭЛ', 0, 0, 4, null, 1, now],
        ['ТЦ ЕКБ — все новые аварии', 'email', 'tc-ekb@example.local, ekb-engineers@example.local', '', '', 'ЕКБ', '', 1, 0, null, null, 1, now],
        ['Утренняя сводка — руководству ЦОУ', 'email', 'cou-head@example.local', '', '', '', '', 0, 0, null, '08:00', 1, now],
      ]],
    );
    console.log('[seed] правила уведомлений: 4 демо-правила');
  }

  const [{ c }] = await select<{ c: number }>('SELECT COUNT(*) AS c FROM alarms');
  if (Number(c) > 0) return;

  const nowStr = nowWall();
  const nowMs = parseDateTime(nowStr) as number;
  const DAY = 86400000;
  const rows: unknown[][] = [];

  const push = (o: {
    PW: string | null; NAPR: string; TEHC: string | null; KATEG: number; NETW: string; SERV: string; NUMB: string; EQIP: string | null;
    TYPE: string; DESCR: string; begin: number; end: number | null; akb: number | null; dgu: number | null; prostoy: number | null;
    WHO: string; NOTICE: string;
  }) => {
    const len = Math.max(0, Math.round(((o.end === null ? nowMs : o.end) - o.begin) / 1000));
    const common = computeCommonSeconds(o.prostoy, o.NUMB);
    rows.push([
      o.PW || null, o.NAPR, o.TEHC, o.KATEG, o.NETW, o.SERV, o.NUMB, o.EQIP || null, o.TYPE, o.DESCR,
      formatDateTime(o.begin), o.end === null ? ZERO_DATETIME : formatDateTime(o.end),
      o.akb === null ? null : formatDuration(o.akb), o.dgu === null ? null : formatDuration(o.dgu),
      formatDuration(len), o.prostoy === null ? null : formatDuration(o.prostoy),
      common === null ? null : formatDuration(common), o.WHO || null, o.NOTICE || null,
    ]);
  };

  // ---------------- 1. строки сводки ЦОУ: сдвиг на целое число суток, время суток сохраняется
  let blockStart = nowMs;
  let blockEnd = nowMs;
  if (summary && real.length) {
    const fileNowMs = parseDateTime(summary.fileNow) as number;
    const shift = Math.floor((nowMs - fileNowMs) / DAY) * DAY;
    blockEnd = fileNowMs + shift;
    blockStart = blockEnd - 3.5 * DAY;
    for (const a of real) {
      const begin = (parseDateTime(a.BEGIN_TIME) as number) + shift;
      const end = a.END_TIME ? (parseDateTime(a.END_TIME) as number) + shift : null;
      push({
        PW: a.PW, NAPR: a.NAPR, TEHC: a.TEHC || null, KATEG: a.KATEG || 3, NETW: a.NETW_TYPE, SERV: a.SERV_ELEM,
        NUMB: a.NUMB_RBS || '1', EQIP: a.EQIP_TYPE, TYPE: a.ALARM_TYPE, DESCR: a.DESCR, begin, end,
        akb: a.AKB_SEC, dgu: a.DGU_SEC, prostoy: end === null ? null : a.PROSTOY_SEC, WHO: oneLine(a.ALARM_WHO), NOTICE: a.DESC_NOTICE,
      });
    }
  }

  // ---------------- 2. история за 60 дней вокруг строк сводки
  const histStart = nowMs - 60 * DAY;
  const inBlock = (t: number) => t >= blockStart && t <= blockEnd;
  // Номера NTT растут со временем: ~45 заявок в сутки, к дате сводки — около 63 600.
  const nttAt = (t: number) => 'NTT-' + Math.max(10000, Math.round(63600 - (blockEnd - t) / DAY * 45 + (r() - 0.5) * 20));
  const whoFor = (tehc: string, begin: number) => {
    const list = tcWho.get(tehc);
    let w = oneLine(list && list.length ? pick(r, list) : 'Начальнику ТЦ (при получении сводки)');
    if (/^\d{1,2}:\d{2}\s/.test(w)) {
      const t = new Date(begin + (5 + Math.floor(r() * 35)) * 60000);
      w = w.replace(/^\d{1,2}:\d{2}/, String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0'));
    }
    return w;
  };

  const make = (st: SeedStation, type: string, begin: number, storm: boolean, descrForce?: string) => {
    const descr = descrForce || (descrW.get(type) ? pickW(r, descrW.get(type) as Array<[string, number]>) : 'Авария');
    const len = durationFor(r, type, descr, storm);
    let end: number | null = begin + len * 1000;
    if (end > nowMs - 60000) end = null; // ещё продолжается — окончание НВ
    if (end !== null && inBlock(end) && !inBlock(begin)) end = Math.min(end, blockStart - 60000);
    const lenSec = Math.round(((end === null ? nowMs : end) - begin) / 1000);
    const d = descr.toLowerCase();
    const sector = /сектор/.test(d);
    let akb: number | null = null;
    let dgu: number | null = null;
    let prostoy: number | null = 0;
    if (end === null) prostoy = null;
    else if (type === 'ЭЛ') {
      const autonomy = (st.akbMin || 90) * 60 * (0.7 + r() * 0.4);
      const onAkb = Math.min(lenSec, Math.round(autonomy / 60) * 60);
      if (r() < 0.5) akb = onAkb;
      if (st.dgu && lenSec - onAkb > 15 * 60) dgu = lenSec - onAkb - (10 + Math.floor(r() * 25)) * 60;
      prostoy = estimateProstoySeconds(lenSec, onAkb, dgu);
    } else if ((type === 'RBS' && /блокиров/.test(d)) || (type === 'РРЛ' && /блокиров/.test(d))) prostoy = lenSec;
    const notices = noticeOf.get(type) || [];
    const kateg = pickW(r, kategW[type] || [[3, 1]]);
    push({
      PW: r() < 0.32 ? nttAt(begin) : r() < 0.02 ? 'PW-' + (17800000 + Math.floor(r() * 99999)) : '',
      NAPR: st.napr, TEHC: st.tehc, KATEG: storm && r() < 0.2 ? 2 : kateg, NETW: st.netw, SERV: st.elem,
      NUMB: sector ? SECTOR_LABEL : String(st.bs),
      EQIP: type === 'RBS' ? st.eq : type === 'ОПС' && r() < 0.5 ? 'Гранит-4' : '',
      TYPE: type, DESCR: descr, begin, end, akb, dgu, prostoy,
      WHO: whoFor(st.tehc, begin),
      NOTICE: end === null && r() < 0.4 ? 'Причина выясняется.' : notices.length && r() < 0.75 ? pick(r, notices) : '',
    });
  };

  // «Проблемные» объекты получают аварии чаще — их видно в статистике повторов.
  const weighted: Array<[SeedStation, number]> = stations.map((s, i) => [s, i % 29 === 7 ? 8 : s.tehc === 'ЕКБ' ? 1.5 : 1]);

  // Грозовые дни: волна отключений электропитания в 1–3 ТЦ одного направления за несколько часов.
  const stormDays = new Set<number>();
  while (stormDays.size < 7) stormDays.add(2 + Math.floor(r() * 56));

  for (let day = 60; day >= 0; day--) {
    const dayStart = Math.floor((nowMs - day * DAY) / DAY) * DAY;
    const weekday = new Date(dayStart).getUTCDay();
    const base = Math.round((weekday === 0 || weekday === 6 ? 17 : 22) + gauss(r) * 4);
    for (let i = 0; i < base; i++) {
      const type = pickW(r, typeW);
      const t = beginOfDay(r, type);
      const begin = dayStart + (t.hour * 60 + t.minute) * 60000;
      if (begin < histStart || begin > nowMs - 5 * 60000 || inBlock(begin)) continue;
      make(pickW(r, weighted), type, begin, false);
    }
    if (stormDays.has(day)) {
      const dir = pick(r, Array.from(new Set(stations.map((s) => s.napr))));
      const dirTcs = Array.from(new Set(stations.filter((s) => s.napr === dir).map((s) => s.tehc)));
      const hit = dirTcs.sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 3));
      const victims = stations.filter((s) => hit.indexOf(s.tehc) >= 0).sort(() => r() - 0.5);
      const front = dayStart + (13 + Math.floor(r() * 5)) * 3600000; // фронт грозы
      const n = Math.min(victims.length, 12 + Math.floor(r() * 22));
      for (let k = 0; k < n; k++) {
        const begin = front + Math.round(Math.abs(gauss(r)) * 70 + k * 3) * 60000;
        if (begin > nowMs - 5 * 60000 || inBlock(begin)) continue;
        const promset = r() < 0.75;
        make(victims[k], 'ЭЛ', begin, true, promset ? 'Аварийное отключение промсети' : 'Аварийное отключение сети');
        if (r() < 0.15) make(victims[k], 'РРЛ', begin + Math.floor(r() * 40) * 60000, true, 'Блокировка БС');
      }
    }
  }

  rows.sort((a, b) => String(a[10]).localeCompare(String(b[10])));
  for (let i = 0; i < rows.length; i += 400) {
    await exec(
      `INSERT INTO alarms (PW, NAPR, TEHC, KATEG, NETW_TYPE, SERV_ELEM, NUMB_RBS, EQIP_TYPE, ALARM_TYPE, DESCR,
        BEGIN_TIME, END_TIME, AKB, DGU, LENGHT, PROSTOY, COMMON_PROSTOY, ALARM_WHO, DESC_NOTICE) VALUES ?`,
      [rows.slice(i, i + 400)],
    );
  }
  const duty = (await select('SELECT id, login, full_name FROM users WHERE role = ? ORDER BY id LIMIT 1', ['duty']))[0] ||
    (await select('SELECT id, login, full_name FROM users ORDER BY id LIMIT 1'))[0];
  if (duty) {
    const created = await select('SELECT ID, BEGIN_TIME FROM alarms ORDER BY ID');
    const audit = created.map((a) => [
      formatDateTime(Math.min(nowMs, (parseDateTime(a.BEGIN_TIME) as number) + (4 + (a.ID % 20)) * 60000)),
      duty.id, duty.login, duty.full_name, 'alarm_create', a.ID, JSON.stringify({ demo: true }),
    ]);
    for (let i = 0; i < audit.length; i += 500) {
      await exec('INSERT INTO audit_log (ts, user_id, user_login, user_name, action, alarm_id, details) VALUES ?', [audit.slice(i, i + 500)]);
    }
  }
  const open = rows.filter((x) => x[11] === ZERO_DATETIME).length;
  console.log(`[seed] аварии: ${rows.length} (из сводки ЦОУ ${real.length}, сгенерировано ${rows.length - real.length}), открытых ${open}`);
}
