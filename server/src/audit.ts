import { Router } from 'express';
import { select } from './db.js';
import { requireAdmin, requireAuth } from './auth.js';
import { intParam, str } from './http.js';
import { addDays } from '../../shared/time.js';

function mapAudit(r: any) {
  let details: unknown = null;
  if (r.details) {
    try {
      details = JSON.parse(r.details);
    } catch {
      details = r.details;
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    user_id: r.user_id,
    user_login: r.user_login,
    user_name: r.user_name,
    action: r.action,
    alarm_id: r.alarm_id,
    details,
  };
}

export const auditRouter = Router();

/** История изменений одной аварии — доступна всем ролям (прозрачность). */
auditRouter.get('/alarms/:id/history', requireAuth, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const rows = await select(
    'SELECT * FROM audit_log WHERE alarm_id = ? ORDER BY ts DESC, id DESC LIMIT 200',
    [id],
  );
  res.json({ items: rows.map(mapAudit) });
});

/** Полный журнал действий — только администратор. */
auditRouter.get('/audit', requireAdmin, async (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const from = str(req.query.from);
  const to = str(req.query.to);
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push('ts >= ?');
    params.push(from + ' 00:00:00');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push('ts < ?');
    params.push(addDays(to, 1) + ' 00:00:00');
  }
  const action = str(req.query.action);
  if (action) {
    if (action === 'alarm') where.push("action LIKE 'alarm\\_%'");
    else if (action === 'auth') where.push("action IN ('login','login_failed','logout','password_change')");
    else if (action === 'user') where.push("action LIKE 'user\\_%'");
    else if (action === 'settings') where.push("(action LIKE 'dict\\_%' OR action LIKE 'station\\_%' OR action LIKE 'rule\\_%' OR action LIKE 'settings\\_%' OR action LIKE 'token\\_%')");
    else {
      where.push('action = ?');
      params.push(action);
    }
  }
  const user = str(req.query.user);
  if (user) {
    where.push('(user_login LIKE ? OR user_name LIKE ?)');
    params.push('%' + user + '%', '%' + user + '%');
  }
  const alarmId = intParam(req.query.alarm_id, 0, 0, 2 ** 31);
  if (alarmId) {
    where.push('alarm_id = ?');
    params.push(alarmId);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pageSize = intParam(req.query.pageSize, 50, 10, 500);
  const page = intParam(req.query.page, 1, 1, 100000);
  const [{ total }] = await select<{ total: number }>(`SELECT COUNT(*) AS total FROM audit_log ${whereSql}`, params);
  const rows = await select(
    `SELECT * FROM audit_log ${whereSql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  res.json({ items: rows.map(mapAudit), total: Number(total), page, pageSize });
});
