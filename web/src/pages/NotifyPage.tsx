import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api, qs } from '../api';
import type { Channel, NotifyLogEntry, NotifyRule, NotifyStatus } from '../types';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { AlarmEditor, NOTIFY_EVENT, NOTIFY_STATUS } from '../components/AlarmEditor';
import { IconPlus } from '../components/Icons';
import { ChannelsPanel } from './ChannelSettings';
import { allValues, noteMap, num } from '../format';
import { humanDateTime } from '../../../shared/time';

interface RulesResp {
  items: NotifyRule[];
  status: NotifyStatus;
}

interface LogResp {
  items: NotifyLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

function conditions(r: NotifyRule): string {
  const parts: string[] = [];
  if (r.kateg.length) parts.push('кат. ' + r.kateg.join(', '));
  if (r.napr.length) parts.push(r.napr.join(', '));
  if (r.tehc.length) parts.push('ТЦ ' + r.tehc.join(', '));
  if (r.alarm_types.length) parts.push('тип ' + r.alarm_types.join(', '));
  return parts.length ? parts.join('; ') : 'все аварии';
}

function events(r: NotifyRule): string {
  const parts: string[] = [];
  if (r.on_create) parts.push('при внесении');
  if (r.on_close) parts.push('при закрытии');
  if (r.long_hours) parts.push('если открыта дольше ' + String(r.long_hours).replace('.', ',') + ' ч');
  if (r.daily_at) parts.push('сводка за сутки в ' + r.daily_at);
  return parts.join(', ');
}

export function NotifyPage() {
  const app = useApp();
  const [rules, setRules] = useState<RulesResp | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<NotifyRule | 'new' | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(
    function () {
      api.get<RulesResp>('/api/notify/rules')
        .then(function (r) { setRules(r); setError(''); })
        .catch(function (e: ApiError) { setError(e.message); });
    },
    [reload],
  );

  const st = rules ? rules.status : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Уведомления</h1>
          <p>Кому и о каких авариях приложение сообщает само — письмом на внутренние адреса компании</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={function () { setEditing('new'); }}>
          <IconPlus />
          Добавить правило
        </button>
      </div>

      {error ? <div className="alert alert-err">{error}</div> : null}

      <ChannelsPanel onChanged={function () { setReload(reload + 1); }} />

      <section className="panel">
        <div className="panel-head">
          <h2>Правила</h2>
          <span className="hint">Пустое условие — подходит любое значение. Нажмите на правило, чтобы изменить или проверить его</span>
        </div>
        {rules && !rules.items.length ? (
          <div className="empty">
            <b>Правил пока нет</b>
            Добавьте первое правило, например «Категория 1 — дежурной смене по e-mail».
          </div>
        ) : null}
        {rules && rules.items.length ? (
          <div className="table-wrap free">
            <table className="data">
              <thead>
                <tr>
                  <th>Правило</th>
                  <th>Кому</th>
                  <th>Какие аварии</th>
                  <th>Когда</th>
                  <th className="num">Отправлено</th>
                  <th>Последнее</th>
                </tr>
              </thead>
              <tbody>
                {rules.items.map(function (r) {
                  return (
                    <tr key={r.id} className={'clickable' + (r.is_active ? '' : ' dim')} tabIndex={0}
                      onClick={function () { setEditing(r); }}
                      onKeyDown={function (e) { if (e.key === 'Enter') setEditing(r); }}>
                      <td><b>{r.name}</b>{r.is_active ? null : <span className="tag tag-off">выключено</span>}</td>
                      <td className="clip-l" title={r.target}>
                        {r.target}
                      </td>
                      <td>{conditions(r)}</td>
                      <td>{events(r)}</td>
                      <td className="num">{num(r.sent || 0)} из {num(r.total || 0)}</td>
                      <td className="t">{r.last ? humanDateTime(r.last) : <span className="faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <NotifyLog reload={reload} onChanged={function () { setReload(reload + 1); }} />

      {editing ? (
        <RuleDialog rule={editing === 'new' ? null : editing} status={st}
          onClose={function () { setEditing(null); }}
          onSaved={function () { setEditing(null); setReload(reload + 1); }}
          onTested={function () { setReload(reload + 1); app.bump(); }} />
      ) : null}
    </div>
  );
}

function NotifyLog(props: { reload: number; onChanged: () => void }) {
  const app = useApp();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LogResp | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [alarmId, setAlarmId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    function () {
      let alive = true;
      api.get<LogResp>('/api/notify/log' + qs({ status: status, page: page, pageSize: 25 }))
        .then(function (r) { if (alive) setData(r); })
        .catch(function () { /* журнал не критичен */ });
      return function () { alive = false; };
    },
    [status, page, props.reload],
  );

  function retry(n: NotifyLogEntry) {
    setBusy(true);
    api.post<{ ok: boolean; error?: string }>('/api/notify/log/' + n.id + '/retry')
      .then(function (r) {
        app.toast(r.ok ? 'Сообщение отправлено' : 'Не отправлено: ' + r.error, r.ok ? 'ok' : 'err');
        props.onChanged();
      })
      .catch(function (e: ApiError) { app.toast(e.message, 'err'); })
      .then(function () { setBusy(false); });
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Журнал уведомлений</h2>
        <div className="hstack">
          <label className="muted small" htmlFor="nl-status">Статус</label>
          <select id="nl-status" className="select select-sm" value={status} onChange={function (e) { setStatus(e.target.value); setPage(1); }}>
            <option value="">Все</option>
            <option value="sent">Отправлено</option>
            <option value="failed">Ошибка</option>
            <option value="skipped">Не отправлено (канал не подключён)</option>
          </select>
        </div>
      </div>
      {data && !data.items.length ? (
        <div className="empty">
          <b>Сообщений нет</b>
          Здесь появятся уведомления, когда авария попадёт под правило.
        </div>
      ) : null}
      {data && data.items.length ? (
        <div className="table-wrap free">
          <table className="data">
            <thead>
              <tr>
                <th>Время</th>
                <th>Событие</th>
                <th>Авария</th>
                <th>Кому</th>
                <th>Правило</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map(function (n) {
                const expanded = openId === n.id;
                return [
                  <tr key={n.id}>
                    <td className="t">{humanDateTime(n.ts, true)}</td>
                    <td>{NOTIFY_EVENT[n.event] || n.event}</td>
                    <td>
                      {n.alarm_id ? (
                        <button type="button" className="btn-link" onClick={function () { setAlarmId(n.alarm_id); }}>№{n.alarm_id}</button>
                      ) : <span className="faint">—</span>}
                    </td>
                    <td className="clip-l" title={n.target}>
                      {n.target}
                    </td>
                    <td className="clip" title={n.rule_name || ''}>{n.rule_name}</td>
                    <td>
                      <span className={'tag tag-st-' + n.status}>{NOTIFY_STATUS[n.status] || n.status}</span>
                      {n.error ? <div className="small muted clip-msg" title={n.error}>{n.error}</div> : null}
                    </td>
                    <td className="nowrap">
                      <button type="button" className="btn btn-xs" aria-expanded={expanded}
                        onClick={function () { setOpenId(expanded ? null : n.id); }}>
                        {expanded ? 'Скрыть текст' : 'Текст'}
                      </button>
                      {n.status === 'failed' || n.status === 'skipped' ? (
                        <button type="button" className="btn btn-xs" disabled={busy} onClick={function () { retry(n); }}>Отправить снова</button>
                      ) : null}
                    </td>
                  </tr>,
                  expanded ? (
                    <tr key={n.id + '-body'} className="msg-row">
                      <td colSpan={7}>
                        <div className="msg-preview">
                          <b>{n.subject}</b>
                          <pre>{n.body}</pre>
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {data && data.total > data.pageSize ? (
        <div className="pager">
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={function () { setPage(page - 1); }}>Назад</button>
          <span>Страница {page} из {pages}, всего {num(data.total)}</span>
          <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={function () { setPage(page + 1); }}>Вперёд</button>
        </div>
      ) : null}
      {alarmId !== null ? <AlarmEditor alarmId={alarmId} onClose={function () { setAlarmId(null); }} /> : null}
    </section>
  );
}

interface RuleForm {
  name: string;
  channel: Channel;
  target: string;
  kateg: string[];
  napr: string[];
  tehc: string[];
  alarm_types: string[];
  on_create: boolean;
  on_close: boolean;
  long_hours: string;
  daily_at: string;
  is_active: boolean;
}

/** Выбор нескольких значений «кнопками»: ничего не выбрано — подходит любое. */
function ChipSet(props: { id: string; options: string[]; value: string[]; onChange: (v: string[]) => void; titles?: Record<string, string>; prefix?: string }) {
  return (
    <div className="chipset" id={props.id} role="group">
      {props.options.map(function (o) {
        const on = props.value.indexOf(o) >= 0;
        return (
          <button key={o} type="button" className={'chip' + (on ? ' on' : '')} aria-pressed={on}
            title={props.titles && props.titles[o] ? props.titles[o] : undefined}
            onClick={function () {
              props.onChange(on ? props.value.filter(function (x) { return x !== o; }) : props.value.concat([o]));
            }}>
            {(props.prefix || '') + o}
          </button>
        );
      })}
    </div>
  );
}

function RuleDialog(props: {
  rule: NotifyRule | null;
  status: NotifyStatus | null;
  onClose: () => void;
  onSaved: () => void;
  onTested: () => void;
}) {
  const app = useApp();
  const dict = app.meta.dict;
  const r = props.rule;
  const [f, setF] = useState<RuleForm>({
    name: r ? r.name : '',
    channel: r ? r.channel : 'email',
    target: r ? r.target : '',
    kateg: r ? r.kateg : ['1'],
    napr: r ? r.napr : [],
    tehc: r ? r.tehc : [],
    alarm_types: r ? r.alarm_types : [],
    on_create: r ? r.on_create : true,
    on_close: r ? r.on_close : false,
    long_hours: r && r.long_hours ? String(r.long_hours).replace('.', ',') : '',
    daily_at: r && r.daily_at ? r.daily_at : '',
    is_active: r ? r.is_active : true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; skipped?: boolean; error?: string; count?: number } | null>(null);

  function set(patch: Partial<RuleForm>) {
    setF(Object.assign({}, f, patch));
  }

  function save() {
    setBusy(true);
    const req = r ? api.put('/api/notify/rules/' + r.id, f) : api.post('/api/notify/rules', f);
    req
      .then(function () { app.toast(r ? 'Правило «' + f.name + '» сохранено' : 'Правило «' + f.name + '» создано'); props.onSaved(); })
      .catch(function (e: ApiError) { setErrors(e.fields); app.toast(e.message, 'err'); setBusy(false); });
  }

  function remove() {
    if (!r || !window.confirm('Удалить правило «' + r.name + '»? Журнал отправленных сообщений сохранится.')) return;
    setBusy(true);
    api.del('/api/notify/rules/' + r.id)
      .then(function () { app.toast('Правило удалено'); props.onSaved(); })
      .catch(function (e: ApiError) { app.toast(e.message, 'err'); setBusy(false); });
  }

  function sendTest() {
    if (!r) return;
    setBusy(true);
    setTest(null);
    api.post<{ ok: boolean; skipped?: boolean; error?: string; count?: number }>('/api/notify/rules/' + r.id + '/test')
      .then(function (res) { setTest(res); props.onTested(); })
      .catch(function (e: ApiError) { setTest({ ok: false, error: e.message }); })
      .then(function () { setBusy(false); });
  }

  const typeNotes = noteMap(dict.items, 'type');

  return (
    <Modal title={r ? 'Правило «' + r.name + '»' : 'Новое правило уведомлений'} onClose={props.onClose} size="mid"
      footer={
        <>
          {r ? <button type="button" className="btn btn-danger left" onClick={remove} disabled={busy}>Удалить</button> : null}
          {r ? (
            <button type="button" className="btn" onClick={sendTest} disabled={busy}
              title="Отправить на адреса правила пример того, что оно присылает: сообщение по последней аварии и сводку, если она включена">
              Отправить проверочное
            </button>
          ) : null}
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{r ? 'Сохранить' : 'Создать правило'}</button>
        </>
      }>
      <div className="modal-body">
        {test ? (
          <div className={'alert ' + (test.ok ? 'alert-info' : test.skipped ? 'alert-warn' : 'alert-err')} style={{ marginBottom: 14 }}>
            {test.ok ? (test.count && test.count > 1 ? 'Проверочные сообщения отправлены (' + test.count + ') — проверьте ' : 'Проверочное сообщение отправлено — проверьте ') + 'почту.' :
              test.skipped ? test.error + '. Сообщение сохранено в журнале — его текст можно посмотреть там.' :
                'Не удалось отправить: ' + test.error}
          </div>
        ) : null}
        <div className="grid">
          <Field label="Название" htmlFor="nr-name" required className="c-12" error={errors.name}>
            <input id="nr-name" className="input" value={f.name} autoComplete="off" placeholder="Например: Категория 1 — дежурная смена ЦОУ"
              onChange={function (e) { set({ name: e.target.value }); }} />
          </Field>
          <Field label="Адреса e-mail" htmlFor="nr-target" required className="c-12" error={errors.target}
            help="Через запятую, только внутренние адреса компании: cou-duty@motiv.ru, tc-ekb@motiv.ru">
            <input id="nr-target" className="input" value={f.target} autoComplete="off"
              onChange={function (e) { set({ target: e.target.value }); }} />
          </Field>
          <Field label="Категории" htmlFor="nr-kateg" className="c-12" error={errors.kateg} help="Ничего не выбрано — любая категория">
            <ChipSet id="nr-kateg" options={['1', '2', '3']} value={f.kateg} prefix="Кат. " onChange={function (v) { set({ kateg: v }); }} />
          </Field>
          <Field label="Типы аварий" htmlFor="nr-types" className="c-12" error={errors.alarm_types} help="Ничего не выбрано — любой тип">
            <ChipSet id="nr-types" options={allValues(dict.items, 'type')} value={f.alarm_types} titles={typeNotes}
              onChange={function (v) { set({ alarm_types: v }); }} />
          </Field>
          <Field label="Направления" htmlFor="nr-napr" className="c-12" error={errors.napr} help="Ничего не выбрано — любое направление">
            <ChipSet id="nr-napr" options={allValues(dict.items, 'napr')} value={f.napr} onChange={function (v) { set({ napr: v }); }} />
          </Field>
          <Field label="Технические центры" htmlFor="nr-tehc" className="c-12" error={errors.tehc} help="Ничего не выбрано — любой ТЦ">
            <ChipSet id="nr-tehc" options={allValues(dict.items, 'tehc')} value={f.tehc} onChange={function (v) { set({ tehc: v }); }} />
          </Field>
          <div className="c-12">
            <div className="field-label"><span>Когда сообщать</span></div>
            <div className="checks-row">
              <label className="check">
                <input type="checkbox" checked={f.on_create} onChange={function (e) { set({ on_create: e.target.checked }); }} />
                При внесении аварии
              </label>
              <label className="check">
                <input type="checkbox" checked={f.on_close} onChange={function (e) { set({ on_close: e.target.checked }); }} />
                При закрытии
              </label>
              <label className="check inline-num">
                <input type="checkbox" checked={!!f.long_hours} onChange={function (e) { set({ long_hours: e.target.checked ? '4' : '' }); }} />
                Если авария открыта дольше
                <input className={'input tnum' + (errors.long_hours ? ' invalid' : '')} value={f.long_hours} aria-label="Часов" inputMode="decimal"
                  onChange={function (e) { set({ long_hours: e.target.value.replace(/[^\d.,]/g, '') }); }} />
                ч
              </label>
              <label className="check inline-num">
                <input type="checkbox" checked={!!f.daily_at} onChange={function (e) { set({ daily_at: e.target.checked ? '08:00' : '' }); }} />
                Сводка за сутки в
                <input type="time" className={'input tnum input-time' + (errors.daily_at ? ' invalid' : '')} value={f.daily_at} aria-label="Время сводки"
                  onChange={function (e) { set({ daily_at: e.target.value }); }} />
              </label>
            </div>
            {errors.events || errors.long_hours || errors.daily_at ? (
              <div className="field-error">{errors.events || errors.long_hours || errors.daily_at}</div>
            ) : (
              <div className="field-help">
                Сводка — каждый день в заданное время: сколько аварий за сутки, каких типов, что открыто сейчас и самые долгие
              </div>
            )}
          </div>
          <div className="c-12">
            <label className="check">
              <input type="checkbox" checked={f.is_active} onChange={function (e) { set({ is_active: e.target.checked }); }} />
              Правило включено
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}
