import type { NextFunction, Request, Response } from 'express';

/** Ошибка с HTTP-статусом и понятным пользователю текстом (и, при необходимости, ошибками по полям). */
export class HttpError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(status: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, fields: err.fields });
    return;
  }
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Некорректный JSON в запросе' });
    return;
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера. Подробности — в логе приложения.' });
}

export function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

export function intParam(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v), 10);
  if (isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
