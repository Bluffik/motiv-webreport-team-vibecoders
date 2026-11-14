import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { exec, select } from './db.js';
import { nowWall } from './clock.js';
import { logAction } from './auditlog.js';
import { HttpError, str } from './http.js';
import type { Role } from '../../shared/dict.js';

export interface SessionUser {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  is_active: number;
  password_hash: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const COOKIE = 'wr_session';

/** Отпечаток пароля в сессии: после смены пароля старые сессии перестают действовать. */
function stamp(hash: string): string {
  return hash.slice(-12);
}

export function publicUser(u: SessionUser) {
  return { id: u.id, login: u.login, full_name: u.full_name, role: u.role };
}

export async function findUserById(id: number): Promise<SessionUser | null> {
  const rows = await select<SessionUser>('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

/** Проверяет cookie сессии и кладёт пользователя в req.user. Роль и активность читаются из БД на каждый запрос. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies ? req.cookies[COOKIE] : undefined;
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as { uid: number; ps: string };
      const user = await findUserById(payload.uid);
      if (user && user.is_active && stamp(user.password_hash) === payload.ps) req.user = user;
    } catch {
      /* просроченная или поддельная сессия — считаем гостем */
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Войдите в систему'));
  next();
}

/** Внесение и редактирование аварий: администратор и дежурный. */
export function requireEditor(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Войдите в систему'));
  if (req.user.role !== 'admin' && req.user.role !== 'duty') {
    return next(new HttpError(403, 'Роль «Инженер» — только просмотр. Изменения вносит дежурный или администратор.'));
  }
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Войдите в систему'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Действие доступно только администратору'));
  next();
}

function setSessionCookie(res: Response, user: SessionUser) {
  const token = jwt.sign({ uid: user.id, ps: stamp(user.password_hash) }, config.jwtSecret, {
    expiresIn: Math.round(config.sessionHours * 3600),
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // По HTTPS (встроенному или через балансировщик) cookie всегда помечается Secure.
    secure: config.cookieSecure || res.req.secure,
    maxAge: config.sessionHours * 3600 * 1000,
    path: '/',
  });
}

// Простая защита от перебора: 8 неудачных попыток за 15 минут с одного адреса для одного логина.
const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

function failKey(req: Request, login: string) {
  return (req.ip || '') + '|' + login.toLowerCase();
}

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const login = str(req.body?.login);
  const password = String(req.body?.password ?? '');
  if (!login || !password) throw new HttpError(400, 'Введите логин и пароль');

  const key = failKey(req, login);
  const f = failures.get(key);
  if (f && Date.now() - f.first < WINDOW_MS && f.count >= MAX_FAILS) {
    throw new HttpError(429, 'Слишком много неудачных попыток. Повторите через 15 минут или обратитесь к администратору.');
  }

  const rows = await select<SessionUser>('SELECT * FROM users WHERE login = ?', [login]);
  const user = rows[0];
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!user || !ok) {
    const cur = f && Date.now() - f.first < WINDOW_MS ? f : { count: 0, first: Date.now() };
    cur.count++;
    failures.set(key, cur);
    await logAction(null, 'login_failed', null, { login, ip: req.ip });
    throw new HttpError(401, 'Неверный логин или пароль');
  }
  if (!user.is_active) throw new HttpError(403, 'Учётная запись отключена. Обратитесь к администратору.');

  failures.delete(key);
  await exec('UPDATE users SET last_login_at = ? WHERE id = ?', [nowWall(), user.id]);
  setSessionCookie(res, user);
  await logAction(user, 'login', null, { ip: req.ip });
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', async (req, res) => {
  if (req.user) await logAction(req.user, 'logout', null, null);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Войдите в систему');
  res.json({ user: publicUser(req.user) });
});

authRouter.post('/password', requireAuth, async (req, res) => {
  const user = req.user!;
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  if (!(await bcrypt.compare(current, user.password_hash))) {
    throw new HttpError(400, 'Текущий пароль указан неверно', { current: 'Неверный пароль' });
  }
  if (next.length < 6) throw new HttpError(400, 'Новый пароль — не короче 6 символов', { next: 'Минимум 6 символов' });
  const hash = await hashPassword(next);
  await exec('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
  user.password_hash = hash;
  setSessionCookie(res, user);
  await logAction(user, 'password_change', null, null);
  res.json({ ok: true });
});
