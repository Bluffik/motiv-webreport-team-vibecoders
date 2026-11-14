import { config } from './config.js';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.tz,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Текущее «настенное» время центра в формате 'YYYY-MM-DD HH:MM:SS' (не зависит от TZ системы). */
export function nowWall(date: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Текущая дата центра 'YYYY-MM-DD'. */
export function todayWall(): string {
  return nowWall().slice(0, 10);
}
