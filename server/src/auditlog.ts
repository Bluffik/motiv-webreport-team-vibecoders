import { exec } from './db.js';
import { nowWall } from './clock.js';

export interface ActorRef {
  id: number;
  login: string;
  full_name: string;
}

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'password_change'
  | 'alarm_create'
  | 'alarm_update'
  | 'alarm_close'
  | 'alarm_delete'
  | 'user_create'
  | 'user_update'
  | 'user_delete'
  | 'dict_create'
  | 'dict_update'
  | 'dict_delete'
  | 'station_create'
  | 'station_update'
  | 'station_delete'
  | 'station_import'
  | 'rule_create'
  | 'rule_update'
  | 'rule_delete'
  | 'alarm_import'
  | 'alarm_restore'
  | 'alarm_purge'
  | 'token_create'
  | 'token_revoke'
  | 'settings_mail'
  | 'settings_mail_test'
  | 'settings_app_url';

export async function logAction(
  user: ActorRef | null,
  action: AuditAction,
  alarmId: number | null,
  details: unknown,
): Promise<void> {
  try {
    await exec(
      'INSERT INTO audit_log (ts, user_id, user_login, user_name, action, alarm_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        nowWall(),
        user && user.id ? user.id : null,
        user ? user.login : null,
        user ? user.full_name : null,
        action,
        alarmId,
        details === undefined || details === null ? null : JSON.stringify(details),
      ],
    );
  } catch (e) {
    // Журнал не должен ломать основную операцию.
    console.error('[audit] не удалось записать событие', e);
  }
}

