import { Router } from 'express';
import { exec, select } from './db.js';
import { nowWall } from './clock.js';
import { hashPassword, requireAdmin } from './auth.js';
import { logAction } from './auditlog.js';
import { HttpError, intParam, str } from './http.js';
import { ROLES, type Role } from '../../shared/dict.js';

const LOGIN_RE = /^[A-Za-z0-9._-]{3,64}$/;

function mapUser(u: any) {
  return {
    id: u.id,
    login: u.login,
    full_name: u.full_name,
    role: u.role,
    is_active: !!u.is_active,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

async function activeAdminCount(exceptId: number): Promise<number> {
  const [r] = await select<{ c: number }>(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1 AND id <> ?",
    [exceptId],
  );
  return Number(r.c);
}

export const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get('/', async (_req, res) => {
  const rows = await select('SELECT * FROM users ORDER BY is_active DESC, role, login');
  res.json({ items: rows.map(mapUser) });
});

usersRouter.post('/', async (req, res) => {
  const login = str(req.body?.login);
  const full_name = str(req.body?.full_name);
  const role = str(req.body?.role) as Role;
  const password = String(req.body?.password ?? '');
  const errors: Record<string, string> = {};
  if (!LOGIN_RE.test(login)) errors.login = 'Латиница, цифры, точка, дефис; 3–64 символа';
  if (!full_name) errors.full_name = 'Укажите ФИО';
  if (ROLES.indexOf(role) < 0) errors.role = 'Выберите роль';
  if (password.length < 6) errors.password = 'Минимум 6 символов';
  if (!errors.login) {
    const exists = await select('SELECT id FROM users WHERE login = ?', [login]);
    if (exists.length) errors.login = 'Такой логин уже есть';
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);
  const r = await exec(
    'INSERT INTO users (login, full_name, role, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    [login, full_name, role, await hashPassword(password), nowWall()],
  );
  await logAction(req.user!, 'user_create', null, { id: r.insertId, login, full_name, role });
  const [u] = await select('SELECT * FROM users WHERE id = ?', [r.insertId]);
  res.status(201).json({ item: mapUser(u) });
});

usersRouter.put('/:id', async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [u] = await select('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  const full_name = str(req.body?.full_name);
  const role = str(req.body?.role) as Role;
  const is_active = req.body?.is_active === false ? 0 : 1;
  const password = String(req.body?.password ?? '');
  const errors: Record<string, string> = {};
  if (!full_name) errors.full_name = 'Укажите ФИО';
  if (ROLES.indexOf(role) < 0) errors.role = 'Выберите роль';
  if (password && password.length < 6) errors.password = 'Минимум 6 символов';
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);

  const losesAdmin = u.role === 'admin' && u.is_active && (role !== 'admin' || !is_active);
  if (losesAdmin && (await activeAdminCount(id)) === 0) {
    throw new HttpError(409, 'Нельзя отключить или понизить последнего администратора');
  }

  const sets = ['full_name = ?', 'role = ?', 'is_active = ?'];
  const params: unknown[] = [full_name, role, is_active];
  if (password) {
    sets.push('password_hash = ?');
    params.push(await hashPassword(password));
  }
  await exec(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  const changes: Record<string, unknown> = { id, login: u.login };
  if (u.full_name !== full_name) changes.full_name = [u.full_name, full_name];
  if (u.role !== role) changes.role = [u.role, role];
  if (!!u.is_active !== !!is_active) changes.is_active = [!!u.is_active, !!is_active];
  if (password) changes.password = 'сброшен';
  await logAction(req.user!, 'user_update', null, changes);
  const [nu] = await select('SELECT * FROM users WHERE id = ?', [id]);
  res.json({ item: mapUser(nu) });
});

usersRouter.delete('/:id', async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  if (id === req.user!.id) throw new HttpError(409, 'Нельзя удалить собственную учётную запись');
  const [u] = await select('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) throw new HttpError(404, 'Пользователь не найден');
  if (u.role === 'admin' && u.is_active && (await activeAdminCount(id)) === 0) {
    throw new HttpError(409, 'Нельзя удалить последнего администратора');
  }
  await exec('DELETE FROM users WHERE id = ?', [id]);
  await logAction(req.user!, 'user_delete', null, { id, login: u.login, full_name: u.full_name, role: u.role });
  res.json({ ok: true });
});
