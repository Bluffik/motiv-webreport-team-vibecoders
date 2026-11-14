// Работа с датой/временем и длительностями. Общий модуль для сервера и интерфейса.
//
// Все даты — «настенное» время часового пояса центра (APP_TZ) в формате
// 'YYYY-MM-DD HH:MM:SS', без смещения. Для арифметики строка переводится
// в миллисекунды через Date.UTC, поэтому часовой пояс браузера/сервера не влияет.

export const ZERO_DATETIME = '0000-00-00 00:00:00';
/** Верхняя граница типа TIME в MariaDB: 838:59:59. */
export const TIME_MAX_SECONDS = 838 * 3600 + 59 * 60 + 59;
export const OPEN_END_LABEL = 'НВ';

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** 'YYYY-MM-DD HH:MM[:SS]' (или с 'T') → мс; null, если строка пустая/нулевая/некорректная. */
export function parseDateTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = m[6] ? +m[6] : 0;
  if (y === 0 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const check = new Date(ms);
  if (check.getUTCDate() !== d) return null; // 31 февраля и т. п.
  return ms;
}

/** мс → 'YYYY-MM-DD HH:MM:SS'. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds())
  );
}

/** мс → 'YYYY-MM-DD'. */
export function formatDate(ms: number): string {
  return formatDateTime(ms).slice(0, 10);
}

/** 'YYYY-MM-DD HH:MM:SS' → 'ДД.ММ.ГГГГ ЧЧ:ММ' для экрана. */
export function humanDateTime(s: string | null | undefined, withSeconds?: boolean): string {
  const ms = parseDateTime(s);
  if (ms === null) return '';
  const d = new Date(ms);
  return (
    pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + (withSeconds ? ':' + pad2(d.getUTCSeconds()) : '')
  );
}

/** 'YYYY-MM-DD' → 'ДД.ММ.ГГГГ'. */
export function humanDate(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
}

/** Окончание «НВ»: пустое значение или нулевая дата. */
export function isOpenEnd(end: string | null | undefined): boolean {
  return !end || String(end).indexOf('0000-00-00') === 0;
}

/** секунды → 'ЧЧ:ММ:СС' (часы могут быть > 24 и > 99). */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return '';
  const neg = totalSeconds < 0;
  let s = Math.floor(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return (neg ? '-' : '') + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
}

/** Короткая человекочитаемая длительность: «2 ч 05 мин», «3 сут 4 ч». */
export function humanDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return '—';
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (days > 0) return days + ' сут ' + h + ' ч';
  if (h > 0) return h + ' ч ' + pad2(m) + ' мин';
  return m + ' мин';
}

/**
 * Разбор длительности, введённой вручную. Поддерживаются форматы
 * «чч.мм.сс», «чч:мм:сс», «чч:мм», «чч», а также цифры подряд:
 * 0130 → 01:30:00, 013015 → 01:30:15. Возвращает секунды или null.
 */
export function parseDuration(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  let h: number, m = 0, s = 0;
  if (/^\d+$/.test(raw)) {
    if (raw.length <= 3) h = +raw;
    else if (raw.length === 4) { h = +raw.slice(0, 2); m = +raw.slice(2); }
    else if (raw.length === 5) { h = +raw.slice(0, 3); m = +raw.slice(3); }
    else if (raw.length === 6) { h = +raw.slice(0, 2); m = +raw.slice(2, 4); s = +raw.slice(4); }
    else if (raw.length === 7) { h = +raw.slice(0, 3); m = +raw.slice(3, 5); s = +raw.slice(5); }
    else return null;
  } else {
    const parts = raw.split(/\s*[.:,]\s*/);
    if (parts.length < 1 || parts.length > 3) return null;
    for (let i = 0; i < parts.length; i++) if (!/^\d{1,3}$/.test(parts[i])) return null;
    h = +parts[0];
    if (parts.length > 1) m = +parts[1];
    if (parts.length > 2) s = +parts[2];
  }
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/** Нормализация введённой длительности к виду 'ЧЧ:ММ:СС' (или исходная строка, если не распознана). */
export function normalizeDuration(input: string): string {
  const sec = parseDuration(input);
  return sec === null ? input : formatDuration(sec);
}

/** Длительность аварии в секундах: (окончание или «сейчас» при НВ) − начало. */
export function computeLengthSeconds(begin: string | null | undefined, end: string | null | undefined, now: string): number | null {
  const b = parseDateTime(begin);
  if (b === null) return null;
  const e = isOpenEnd(end) ? parseDateTime(now) : parseDateTime(end);
  if (e === null) return null;
  return Math.floor((e - b) / 1000);
}

/** Множитель количества БС: сектор («С», в старых данных — 0) учитывается как одна БС (ответ куратора, вопрос 2). */
export function bsMultiplier(numbRbs: string | number | null | undefined): number | null {
  if (numbRbs === null || numbRbs === undefined) return null;
  const v = String(numbRbs).trim().toUpperCase();
  if (v === 'С' || v === 'C' || v === '0') return 1;
  if (/^\d+$/.test(v)) return +v;
  return null;
}

/** Общее время простоя БС = время перерыва связи × количество БС. */
export function computeCommonSeconds(prostoySeconds: number | null, numbRbs: string | number | null | undefined): number | null {
  const k = bsMultiplier(numbRbs);
  if (prostoySeconds === null || k === null) return null;
  return prostoySeconds * k;
}

/**
 * Оценка перерыва связи при отключении питания: БС работает от АКБ, затем от ГУ,
 * а простой начинается, когда резерв кончился (ответ куратора, вопрос 6).
 * перерыв ≈ длительность − АКБ − ГУ.
 */
export function estimateProstoySeconds(lengthSec: number | null, akbSec: number | null, dguSec: number | null): number | null {
  if (lengthSec === null) return null;
  return Math.max(0, lengthSec - (akbSec || 0) - (dguSec || 0));
}

/** Секунды → значение для столбца TIME (с ограничением диапазона MariaDB). */
export function toSqlTime(seconds: number | null): string | null {
  if (seconds === null) return null;
  return formatDuration(Math.min(Math.max(0, seconds), TIME_MAX_SECONDS));
}

/** 'ЧЧ:ММ:СС' из БД (TIME) → секунды. */
export function sqlTimeToSeconds(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(-)?(\d+):(\d{2}):(\d{2})/.exec(String(t));
  if (!m) return null;
  const v = +m[2] * 3600 + +m[3] * 60 + +m[4];
  return m[1] ? -v : v;
}

/** Сдвиг даты 'YYYY-MM-DD' на n дней. */
export function addDays(date: string, n: number): string {
  const ms = parseDateTime(date + ' 00:00:00');
  if (ms === null) return date;
  return formatDate(ms + n * 86400000);
}
