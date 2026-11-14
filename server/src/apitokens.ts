import crypto from 'node:crypto';
import { Router } from 'express';
import { exec, select } from './db.js';
import { nowWall } from './clock.js';
import { requireAdmin, type SessionUser } from './auth.js';
import { logAction } from './auditlog.js';
import { HttpError, intParam, str } from './http.js';

// Ключи доступа к API для внешних систем (мониторинг, CRM, скрипты ЦОУ).
// Ключ передаётся в заголовке «Authorization: Bearer wr_…». В БД хранится только
// SHA-256 ключа, сам ключ показывается один раз — при создании.
// Права: «read» — как у инженера (просмотр, отчёты, выгрузки), «write» — как у
// дежурного (ещё внесение, изменение и закрытие аварий). Управлять пользователями,
// справочниками и настройками через ключ нельзя.

export type Scope = 'read' | 'write';

const PREFIX = 'wr_';

function hash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const lastTouch = new Map<number, number>();

/** Пользователь для запроса с ключом API или null, если ключ не подошёл. */
export async function userFromToken(header: string | undefined): Promise<SessionUser | null> {
  const m = /^Bearer\s+(wr_[A-Za-z0-9_-]{20,80})\s*$/.exec(header || '');
  if (!m) return null;
  const [t] = await select('SELECT * FROM api_tokens WHERE token_hash = ? AND is_active = 1', [hash(m[1])]);
  if (!t) return null;
  if (t.expires_at && String(t.expires_at) < nowWall()) return null;
  // Время последнего использования — не чаще раза в минуту.
  const now = Date.now();
  if ((lastTouch.get(t.id) || 0) < now - 60000) {
    lastTouch.set(t.id, now);
    await exec('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [nowWall(), t.id]);
  }
  return {
    id: 0,
    login: 'api:' + t.name,
    full_name: 'API: ' + t.name,
    role: t.scope === 'write' ? 'duty' : 'engineer',
    is_active: 1,
    password_hash: '',
  } as SessionUser;
}

function view(r: any) {
  return {
    id: r.id,
    name: r.name,
    scope: r.scope as Scope,
    prefix: r.prefix,
    is_active: !!r.is_active,
    created_at: r.created_at,
    created_by: r.created_by,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
  };
}

export const tokensRouter = Router();

tokensRouter.get('/', requireAdmin, async (_req, res) => {
  const rows = await select('SELECT * FROM api_tokens ORDER BY is_active DESC, id DESC');
  res.json({ items: rows.map(view) });
});

tokensRouter.post('/', requireAdmin, async (req, res) => {
  const name = str(req.body?.name);
  const scope = str(req.body?.scope) as Scope;
  const days = intParam(req.body?.days, 0, 0, 3650);
  const errors: Record<string, string> = {};
  if (!name) errors.name = 'Назовите ключ по системе, которая будет им пользоваться, например «Zabbix»';
  else if (name.length > 100) errors.name = 'Не длиннее 100 символов';
  if (scope !== 'read' && scope !== 'write') errors.scope = 'Выберите права';
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);
  const token = PREFIX + crypto.randomBytes(30).toString('base64url');
  const now = nowWall();
  const expires = days ? new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) + ' 23:59:59' : null;
  const r = await exec(
    'INSERT INTO api_tokens (name, scope, token_hash, prefix, is_active, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
    [name, scope, hash(token), token.slice(0, 10), now, req.user!.login, expires],
  );
  await logAction(req.user!, 'token_create', null, { id: r.insertId, name, scope, expires_at: expires });
  const [row] = await select('SELECT * FROM api_tokens WHERE id = ?', [r.insertId]);
  res.status(201).json({ item: view(row), token });
});

tokensRouter.delete('/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [row] = await select('SELECT * FROM api_tokens WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'Ключ не найден');
  await exec('UPDATE api_tokens SET is_active = 0 WHERE id = ?', [id]);
  await logAction(req.user!, 'token_revoke', null, { id, name: row.name });
  res.json({ ok: true });
});
