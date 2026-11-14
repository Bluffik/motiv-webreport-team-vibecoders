import { useEffect, useState } from 'react';
import { formatDateTime, parseDateTime } from '../../shared/time';

// Часы синхронизируются с сервером: все расчёты «НВ» идут по времени центра,
// даже если у браузера другой часовой пояс или сбиты часы.
let offsetMs = 0;

export function syncServerTime(serverNow: string | null | undefined) {
  const ms = parseDateTime(serverNow);
  if (ms !== null) offsetMs = ms - Date.now();
}

export function nowWallMs(): number {
  return Date.now() + offsetMs;
}

export function nowWall(): string {
  return formatDateTime(nowWallMs());
}

/** Текущее время центра с точностью до минуты (для полей «Начало»/«Окончание»). */
export function nowWallMinute(): string {
  return nowWall().slice(0, 16) + ':00';
}

export function todayWall(): string {
  return nowWall().slice(0, 10);
}

/** Перерисовка компонента раз в intervalMs — для живых таймеров. */
export function useTick(intervalMs: number, enabled: boolean = true): number {
  const [tick, setTick] = useState(0);
  useEffect(
    function () {
      if (!enabled) return undefined;
      const id = window.setInterval(function () {
        setTick(function (t) {
          return t + 1;
        });
      }, intervalMs);
      return function () {
        window.clearInterval(id);
      };
    },
    [intervalMs, enabled],
  );
  return tick;
}
