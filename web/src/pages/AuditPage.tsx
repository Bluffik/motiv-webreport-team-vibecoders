import { useEffect, useState } from 'react';
import { ApiError, api, qs } from '../api';
import type { AuditEntry } from '../types';
import { Field } from '../components/Field';
import { ChangeList } from '../components/AlarmEditor';
import { AlarmEditor } from '../components/AlarmEditor';
import { PeriodFilter, defaultPeriod, type Period } from '../components/PeriodFilter';
import { ACTION_LABELS, num } from '../format';
import { humanDateTime } from '../../../shared/time';

interface Resp {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

function summary(e: AuditEntry): string {
  const d = e.details;
  if (!d || typeof d !== 'object') return '';
  if (e.action === 'login_failed') return 'логин: ' + (d.login || '?');
  if (e.action === 'alarm_create' && d.demo) return 'демо-данные';
  if (e.action === 'alarm_create' || e.action === 'alarm_delete') {
    return [d.TEHC || d.NAPR, d.ALARM_TYPE, d.SERV_ELEM].filter(Boolean).join(', ');
  }
  if (e.action === 'user_create' || e.action === 'user_delete') return (d.login || '') + (d.full_name ? ' — ' + d.full_name : '');
  if (e.action === 'user_update') return d.login || '';
  if (e.action === 'dict_create' || e.action === 'dict_delete' || e.action === 'dict_update') return (d.dict || '') + ': ' + (d.value || '');
  if (e.action.indexOf('station_') === 0) {
    if (e.action === 'station_import') return 'добавлено ' + d.created + ', обновлено ' + d.updated + (d.errors ? ', с ошибками ' + d.errors : '');
    return [d.code, d.address].filter(Boolean).join(', ');
  }
  if (e.action.indexOf('rule_') === 0) return d.name || '';
  if (e.action === 'token_create' || e.action === 'token_revoke') return (d.name || '') + (d.scope ? ' (' + (d.scope === 'write' ? 'чтение и запись' : 'только чтение') + ')' : '');
  if (e.action === 'alarm_import') return (d.file || '') + ': новых ' + (d.created || 0) + ', обновлено ' + (d.updated || 0) + (d.errors ? ', с ошибками ' + d.errors : '');
  if (e.action === 'settings_mail_test') return d.host + ':' + d.port + (d.to ? ', письмо на ' + d.to : '') + (d.ok ? ' — успешно' : ' — ошибка');
  if (e.action === 'settings_mail' && d.password) return 'пароль ' + d.password;
  if (e.action === 'alarm_restore' && d.from) return 'из корзины' + (d.from !== e.alarm_id ? ', прежний №' + d.from : '');
  return '';
}

export function AuditPage() {
  const [period, setPeriod] = useState<Period>(defaultPeriod(7));
  const [action, setAction] = useState('');
  const [user, setUser] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState('');
  const [openAlarm, setOpenAlarm] = useState<number | null>(null);

  useEffect(
    function () {
      let alive = true;
      const t = window.setTimeout(function () {
        api
          .get<Resp>('/api/audit' + qs({ from: period.from, to: period.to, action: action, user: user, page: page, pageSize: 50 }))
          .then(function (r) { if (alive) { setData(r); setError(''); } })
          .catch(function (e: ApiError) { if (alive) setError(e.message); });
      }, 200);
      return function () {
        alive = false;
        window.clearTimeout(t);
      };
    },
    [period.from, period.to, action, user, page],
  );

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Журнал действий</h1>
          <p>Кто, когда и что изменил: внесение, правка, закрытие и удаление аварий, входы, пользователи</p>
        </div>
      </div>
      <section className="panel">
        <div className="filters">
          <div className="grid">
            <PeriodFilter value={period} onChange={function (p) { setPeriod(p); setPage(1); }} idPrefix="au-" hideMode />
            <Field label="Действия" htmlFor="au-action" className="c-2 md-4 sm-6">
              <select id="au-action" className="select" value={action} onChange={function (e) { setAction(e.target.value); setPage(1); }}>
                <option value="">Все</option>
                <option value="alarm">С авариями</option>
                <option value="alarm_update">Только изменения аварий</option>
                <option value="alarm_delete">Только удаления</option>
                <option value="auth">Входы и выходы</option>
                <option value="user">С пользователями</option>
                <option value="settings">Справочники, инвентарь, уведомления, подключения</option>
              </select>
            </Field>
            <Field label="Пользователь" htmlFor="au-user" className="c-3 md-4 sm-6">
              <input id="au-user" className="input" type="search" value={user} placeholder="Логин или ФИО"
                onChange={function (e) { setUser(e.target.value); setPage(1); }} />
            </Field>
          </div>
        </div>
        {error ? <div className="panel-body"><div className="alert alert-err">{error}</div></div> : null}
        {data && !data.items.length ? <div className="empty"><b>Записей нет</b>Измените период или фильтры.</div> : null}
        {data && data.items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Пользователь</th>
                  <th>Действие</th>
                  <th className="num">Авария</th>
                  <th>Подробности</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(function (e) {
                  return (
                    <tr key={e.id}>
                      <td className="t">{humanDateTime(e.ts, true)}</td>
                      <td>{e.user_name || e.user_login || <span className="faint">—</span>}{e.user_login && e.user_name ? <div className="small muted">{e.user_login}</div> : null}</td>
                      <td className="audit-action">{ACTION_LABELS[e.action] || e.action}</td>
                      <td className="num">
                        {e.alarm_id ? (
                          e.action === 'alarm_delete' ? <span className="muted">№{e.alarm_id}</span> : (
                            <button type="button" className="btn-link" onClick={function () { setOpenAlarm(e.alarm_id); }}>№{e.alarm_id}</button>
                          )
                        ) : null}
                      </td>
                      <td className="audit-details">
                        {summary(e)}
                        <ChangeList action={e.action} details={e.details} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {data && data.total > 0 ? (
          <div className="pager">
            <span className="muted">Всего записей: {num(data.total)}</span>
            <span className="spacer" />
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={function () { setPage(page - 1); }}>Назад</button>
            <span className="tnum">{page} / {pages}</span>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={function () { setPage(page + 1); }}>Вперёд</button>
          </div>
        ) : null}
      </section>
      {openAlarm !== null ? <AlarmEditor alarmId={openAlarm} onClose={function () { setOpenAlarm(null); }} /> : null}
    </div>
  );
}
