import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api } from '../api';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { IconPlus } from '../components/Icons';
import { humanDateTime } from '../../../shared/time';

interface Token {
  id: number;
  name: string;
  scope: 'read' | 'write';
  prefix: string;
  is_active: boolean;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  expires_at: string | null;
}

const SCOPE_LABEL = { read: 'только чтение', write: 'чтение и запись' };

/** Ключи API для внешних систем и ссылка на документацию. */
export function ApiPage() {
  const app = useApp();
  const [items, setItems] = useState<Token[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(
    function () {
      api.get<{ items: Token[] }>('/api/tokens')
        .then(function (r) { setItems(r.items); setError(''); })
        .catch(function (e: ApiError) { setError(e.message); });
    },
    [reload],
  );

  function revoke(t: Token) {
    if (!window.confirm('Отозвать ключ «' + t.name + '»? Система, которая им пользуется, сразу потеряет доступ.')) return;
    api.del('/api/tokens/' + t.id)
      .then(function () { app.toast('Ключ «' + t.name + '» отозван'); setReload(reload + 1); })
      .catch(function (e: ApiError) { app.toast(e.message, 'err'); });
  }

  const origin = window.location.origin;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>API</h1>
          <p>Доступ для внешних систем: мониторинга, CRM, скриптов. Все действия по ключу попадают в журнал</p>
        </div>
        <div className="hstack">
          <a className="btn" href="/api/docs" target="_blank" rel="noopener">Документация API</a>
          <button type="button" className="btn btn-primary" onClick={function () { setCreating(true); }}>
            <IconPlus />
            Создать ключ
          </button>
        </div>
      </div>

      {error ? <div className="alert alert-err">{error}</div> : null}

      {fresh ? (
        <section className="panel token-fresh">
          <div className="panel-head">
            <h2>Ключ «{fresh.name}» создан</h2>
            <span className="hint">Скопируйте его сейчас — больше он показан не будет</span>
          </div>
          <div className="token-box">
            <code id="fresh-token">{fresh.token}</code>
            <button type="button" className="btn btn-sm" onClick={function () {
              const el = document.getElementById('fresh-token');
              if (!el) return;
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              if (sel) { sel.removeAllRanges(); sel.addRange(range); }
              try { document.execCommand('copy'); app.toast('Ключ скопирован'); } catch (e) { app.toast('Выделите ключ и скопируйте вручную', 'err'); }
            }}>Скопировать</button>
          </div>
          <pre className="token-example">{'curl \'' + origin + '/api/alarms/open\' \\\n  -H \'Authorization: Bearer ' + fresh.token + '\''}</pre>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Ключи</h2>
          <span className="hint">«Только чтение» — просмотр, отчёты, выгрузки. «Чтение и запись» — ещё внесение и закрытие аварий</span>
        </div>
        {items && !items.length ? (
          <div className="empty">
            <b>Ключей пока нет</b>
            Создайте ключ для системы, которой нужен доступ, например «Zabbix — чтение открытых аварий».
          </div>
        ) : null}
        {items && items.length ? (
          <div className="table-wrap free">
            <table className="data">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Права</th>
                  <th>Ключ</th>
                  <th>Создан</th>
                  <th>Последнее использование</th>
                  <th>Действует до</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map(function (t) {
                  return (
                    <tr key={t.id} className={t.is_active ? '' : 'dim'}>
                      <td><b>{t.name}</b>{t.is_active ? null : <span className="tag tag-off">отозван</span>}</td>
                      <td><span className={'tag' + (t.scope === 'write' ? ' tag-st-skipped' : '')}>{SCOPE_LABEL[t.scope]}</span></td>
                      <td><code>{t.prefix}…</code></td>
                      <td className="t">{humanDateTime(t.created_at)}{t.created_by ? ', ' + t.created_by : ''}</td>
                      <td className="t">{t.last_used_at ? humanDateTime(t.last_used_at) : <span className="faint">не использовался</span>}</td>
                      <td className="t">{t.expires_at ? humanDateTime(t.expires_at).slice(0, 10) : <span className="faint">бессрочно</span>}</td>
                      <td className="nowrap">
                        {t.is_active ? <button type="button" className="btn btn-xs" onClick={function () { revoke(t); }}>Отозвать</button> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {creating ? (
        <TokenDialog onClose={function () { setCreating(false); }}
          onCreated={function (name, token) { setCreating(false); setFresh({ name: name, token: token }); setReload(reload + 1); }} />
      ) : null}
    </div>
  );
}

function TokenDialog(props: { onClose: () => void; onCreated: (name: string, token: string) => void }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [days, setDays] = useState('0');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function create() {
    setBusy(true);
    api.post<{ token: string }>('/api/tokens', { name: name, scope: scope, days: Number(days) })
      .then(function (r) { props.onCreated(name, r.token); })
      .catch(function (e: ApiError) { setErrors(e.fields); app.toast(e.message, 'err'); setBusy(false); });
  }

  return (
    <Modal title="Новый ключ API" onClose={props.onClose} size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>Создать ключ</button>
        </>
      }>
      <div className="modal-body">
        <div className="grid">
          <Field label="Название" htmlFor="tk-name" required className="c-12" error={errors.name}
            help="Для какой системы ключ — так он будет подписан в журнале действий">
            <input id="tk-name" className="input" value={name} autoComplete="off" placeholder="Например: Zabbix"
              onChange={function (e) { setName(e.target.value); }} />
          </Field>
          <Field label="Права" htmlFor="tk-scope" className="c-12" error={errors.scope}>
            <div className="metric-switch" role="group" id="tk-scope">
              <button type="button" className={scope === 'read' ? 'on' : ''} aria-pressed={scope === 'read'} onClick={function () { setScope('read'); }}>Только чтение</button>
              <button type="button" className={scope === 'write' ? 'on' : ''} aria-pressed={scope === 'write'} onClick={function () { setScope('write'); }}>Чтение и запись</button>
            </div>
          </Field>
          <Field label="Срок действия" htmlFor="tk-days" className="c-12">
            <select id="tk-days" className="select" value={days} onChange={function (e) { setDays(e.target.value); }}>
              <option value="0">Бессрочно</option>
              <option value="30">30 дней</option>
              <option value="90">90 дней</option>
              <option value="365">1 год</option>
            </select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}
