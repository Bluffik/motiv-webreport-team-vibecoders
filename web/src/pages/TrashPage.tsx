import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api, qs } from '../api';
import type { Alarm } from '../types';
import { formatBs } from '../../../shared/dict';
import { humanDateTime } from '../../../shared/time';

type Deleted = Alarm & { deleted_at: string; deleted_by: string | null };

/** Корзина: удалённые аварии можно восстановить или удалить навсегда. */
export function TrashPage() {
  const app = useApp();
  const [items, setItems] = useState<Deleted[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(
    function () {
      const t = window.setTimeout(function () {
        api.get<{ items: Deleted[] }>('/api/alarms/trash/list' + qs({ q: q }))
          .then(function (r) { setItems(r.items); setError(''); })
          .catch(function (e: ApiError) { setError(e.message); });
      }, 200);
      return function () { window.clearTimeout(t); };
    },
    [q, reload],
  );

  function restore(a: Deleted) {
    setBusy(true);
    api.post<{ id: number }>('/api/alarms/trash/' + a.ID + '/restore', {})
      .then(function (r) {
        app.toast('Авария №' + r.id + ' восстановлена');
        app.bump();
        setReload(reload + 1);
      })
      .catch(function (e: ApiError) { app.toast(e.message, 'err'); })
      .then(function () { setBusy(false); });
  }

  function purge(a: Deleted) {
    if (!window.confirm('Удалить аварию №' + a.ID + ' навсегда? Восстановить её будет нельзя; копия останется в журнале действий.')) return;
    setBusy(true);
    api.del('/api/alarms/trash/' + a.ID)
      .then(function () { app.toast('Авария №' + a.ID + ' удалена навсегда'); setReload(reload + 1); })
      .catch(function (e: ApiError) { app.toast(e.message, 'err'); })
      .then(function () { setBusy(false); });
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Корзина</h1>
          <p>Удалённые аварии не попадают в отчёты и статистику. Их можно вернуть с прежним номером</p>
        </div>
        <input className="input" style={{ width: 320 }} type="search" value={q} placeholder="Поиск: PW/NTT, объект, описание"
          aria-label="Поиск в корзине" onChange={function (e) { setQ(e.target.value); }} />
      </div>
      {error ? <div className="alert alert-err">{error}</div> : null}
      <section className="panel">
        {items && !items.length ? (
          <div className="empty">
            <b>Корзина пуста</b>
            Удалённые аварии появятся здесь — их можно будет восстановить.
          </div>
        ) : null}
        {items && items.length ? (
          <div className="table-wrap free">
            <table className="data">
              <thead>
                <tr>
                  <th className="num">№</th>
                  <th>Удалена</th>
                  <th>Кем</th>
                  <th>Начало</th>
                  <th>ТЦ</th>
                  <th>Тип</th>
                  <th>Сетевой элемент</th>
                  <th>БС</th>
                  <th>Описание</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map(function (a) {
                  return (
                    <tr key={a.ID}>
                      <td className="num">{a.ID}</td>
                      <td className="t">{humanDateTime(a.deleted_at)}</td>
                      <td>{a.deleted_by || '—'}</td>
                      <td className="t">{humanDateTime(a.BEGIN_TIME)}</td>
                      <td>{a.TEHC || a.NAPR}</td>
                      <td>{a.ALARM_TYPE}</td>
                      <td className="clip" title={a.SERV_ELEM || ''}>{a.SERV_ELEM}</td>
                      <td>{formatBs(a.NUMB_RBS)}</td>
                      <td className="clip" title={a.DESCR || ''}>{a.DESCR}</td>
                      <td className="nowrap">
                        <button type="button" className="btn btn-xs" disabled={busy} onClick={function () { restore(a); }}>Восстановить</button>
                        <button type="button" className="btn btn-xs" disabled={busy} onClick={function () { purge(a); }}>Удалить навсегда</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
