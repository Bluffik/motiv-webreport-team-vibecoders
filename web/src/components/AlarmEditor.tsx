import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api } from '../api';
import { nowWallMinute } from '../clock';
import type { Alarm, AuditEntry, NotifyLogEntry } from '../types';
import { AlarmForm, draftFromAlarm, draftToPayload, validateDraft, type Draft } from './AlarmForm';
import { DateTimeInput } from './DateTimeInput';
import { Field } from './Field';
import { Modal } from './Modal';
import { IconCopy, IconStop, IconTrash } from './Icons';
import { ACTION_LABELS, auditValue, fieldLabel } from '../format';
import { humanDateTime } from '../../../shared/time';

/** Окно просмотра/редактирования аварии (для инженера — только просмотр). */
export function AlarmEditor(props: {
  alarmId: number;
  onClose: () => void;
  onCopy?: (d: Draft) => void;
}) {
  const app = useApp();
  const [alarm, setAlarm] = useState<Alarm | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [closing, setClosing] = useState(false);

  useEffect(
    function () {
      api
        .get<{ item: Alarm }>('/api/alarms/' + props.alarmId)
        .then(function (r) {
          setAlarm(r.item);
          setDraft(draftFromAlarm(r.item));
        })
        .catch(function (e: ApiError) {
          setLoadError(e.message);
        });
    },
    [props.alarmId],
  );

  function save() {
    if (!draft) return;
    const e = validateDraft(draft);
    setErrors(e);
    if (Object.keys(e).length) {
      app.toast('Проверьте выделенные поля', 'err');
      return;
    }
    setBusy(true);
    api
      .put<{ item: Alarm }>('/api/alarms/' + props.alarmId, draftToPayload(draft))
      .then(function () {
        app.toast('Изменения в аварии №' + props.alarmId + ' сохранены');
        app.bump();
        props.onClose();
      })
      .catch(function (err: ApiError) {
        setErrors(err.fields);
        app.toast(err.message, 'err');
      })
      .then(function () {
        setBusy(false);
      });
  }

  function remove() {
    if (!window.confirm('Удалить аварию №' + props.alarmId + '? Она переместится в корзину (Администрирование → Корзина), откуда её можно восстановить.')) return;
    setBusy(true);
    api
      .del('/api/alarms/' + props.alarmId)
      .then(function () {
        app.toast('Авария №' + props.alarmId + ' удалена');
        app.bump();
        props.onClose();
      })
      .catch(function (err: ApiError) {
        app.toast(err.message, 'err');
        setBusy(false);
      });
  }

  const ro = !app.canEdit;
  const title = alarm
    ? 'Авария №' + alarm.ID + (alarm.IS_OPEN ? ' — продолжается' : '')
    : 'Авария №' + props.alarmId;

  const footer = alarm && draft ? (
    <>
      {app.isAdmin ? (
        <button type="button" className="btn btn-danger left" onClick={remove} disabled={busy}>
          <IconTrash />
          Удалить
        </button>
      ) : null}
      {app.canEdit && props.onCopy ? (
        <button type="button" className="btn" onClick={function () { props.onCopy!(draftFromAlarm(alarm, true)); }}>
          <IconCopy />
          Создать копию
        </button>
      ) : null}
      {app.canEdit && alarm.IS_OPEN ? (
        <button type="button" className="btn btn-alarm" onClick={function () { setClosing(true); }}>
          <IconStop />
          Закрыть аварию
        </button>
      ) : null}
      <button type="button" className="btn" onClick={props.onClose}>
        {ro ? 'Закрыть' : 'Отмена'}
      </button>
      {!ro ? (
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          Сохранить изменения
        </button>
      ) : null}
    </>
  ) : undefined;

  return (
    <Modal title={title} onClose={props.onClose} footer={footer}>
      {loadError ? <div className="modal-body"><div className="alert alert-err">{loadError}</div></div> : null}
      {!alarm && !loadError ? <div className="modal-body muted">Загрузка…</div> : null}
      {alarm && draft ? (
        <div
          onKeyDown={function (e) {
            if (!ro && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
          }}
        >
          {ro ? <div className="alert alert-info" style={{ margin: '12px 16px 0' }}>Режим просмотра: роль «Инженер» не может изменять записи.</div> : null}
          <AlarmForm draft={draft} onChange={setDraft} errors={errors} readOnly={ro} idPrefix={'ed' + alarm.ID + '-'} />
          <Notifications alarmId={alarm.ID} />
          <History alarmId={alarm.ID} />
        </div>
      ) : null}
      {closing && alarm ? (
        <CloseDialog
          alarm={alarm}
          onClose={function () { setClosing(false); }}
          onDone={function () {
            setClosing(false);
            props.onClose();
          }}
        />
      ) : null}
    </Modal>
  );
}

/** История изменений аварии из журнала действий. */
export function History(props: { alarmId: number }) {
  const [items, setItems] = useState<AuditEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(
    function () {
      if (!open || items) return;
      api
        .get<{ items: AuditEntry[] }>('/api/alarms/' + props.alarmId + '/history')
        .then(function (r) { setItems(r.items); })
        .catch(function () { setItems([]); });
    },
    [open, props.alarmId, items],
  );
  return (
    <details className="history" onToggle={function (e) { setOpen((e.target as HTMLDetailsElement).open); }}>
      <summary>История изменений</summary>
      {items === null ? (
        <p className="muted" style={{ padding: '0 16px 14px', margin: 0 }}>Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="muted" style={{ padding: '0 16px 14px', margin: 0 }}>Записей нет.</p>
      ) : (
        <ol>
          {items.map(function (h) {
            return (
              <li key={h.id}>
                <span className="when">{humanDateTime(h.ts, true)}</span>
                <b>{ACTION_LABELS[h.action] || h.action}</b>
                <span className="muted"> — {h.user_name || h.user_login || 'система'}</span>
                <ChangeList action={h.action} details={h.details} />
              </li>
            );
          })}
        </ol>
      )}
    </details>
  );
}

export const NOTIFY_EVENT: Record<string, string> = {
  create: 'о новой аварии',
  close: 'о закрытии',
  long: 'эскалация: авария затянулась',
  test: 'проверочное',
  daily: 'ежедневная сводка',
};

export const NOTIFY_STATUS: Record<string, string> = {
  sent: 'отправлено',
  failed: 'ошибка',
  skipped: 'не отправлено',
  pending: 'отправляется',
};

/** Автоуведомления по аварии: кому и когда ушло сообщение. */
export function Notifications(props: { alarmId: number }) {
  const [items, setItems] = useState<NotifyLogEntry[] | null>(null);
  useEffect(
    function () {
      api
        .get<{ items: NotifyLogEntry[] }>('/api/notify/alarm/' + props.alarmId)
        .then(function (r) { setItems(r.items); })
        .catch(function () { setItems([]); });
    },
    [props.alarmId],
  );
  if (!items || !items.length) return null;
  return (
    <details className="history" open>
      <summary>Автоуведомления ({items.length})</summary>
      <ol>
        {items.map(function (n) {
          return (
            <li key={n.id}>
              <span className="when">{humanDateTime(n.ts, true)}</span>
              <span className={'tag tag-st-' + n.status}>{NOTIFY_STATUS[n.status] || n.status}</span>{' '}
              <b>E-mail</b> {NOTIFY_EVENT[n.event] || n.event}: {n.target}
              <span className="change muted">
                Правило «{n.rule_name}»{n.error ? '. ' + n.error : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** Изменения «поле: было → стало» для update/close; для остальных действий — ничего. */
export function ChangeList(props: { action: string; details: any }) {
  const d = props.details;
  if (!d || typeof d !== 'object') return null;
  const withChanges = ['alarm_update', 'alarm_close', 'user_update', 'dict_update', 'station_update', 'rule_update',
    'settings_mail', 'settings_app_url'];
  if (withChanges.indexOf(props.action) < 0) return null;
  const keys = Object.keys(d).filter(function (k) { return Array.isArray(d[k]); });
  if (!keys.length) return null;
  return (
    <>
      {keys.map(function (k) {
        return (
          <span className="change" key={k}>
            {fieldLabel(k)}: <del>{auditValue(k, d[k][0])}</del> → <ins>{auditValue(k, d[k][1])}</ins>
          </span>
        );
      })}
    </>
  );
}

/** Закрытие аварии: окончание по календарю, по умолчанию — сейчас. */
export function CloseDialog(props: { alarm: Alarm; onClose: () => void; onDone: () => void }) {
  const app = useApp();
  const [end, setEnd] = useState(nowWallMinute());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function submit() {
    if (!end) {
      setError('Укажите время окончания');
      return;
    }
    if (props.alarm.BEGIN_TIME && end < props.alarm.BEGIN_TIME) {
      setError('Окончание раньше начала (' + humanDateTime(props.alarm.BEGIN_TIME) + ')');
      return;
    }
    setBusy(true);
    api
      .post<{ item: Alarm }>('/api/alarms/' + props.alarm.ID + '/close', { END_TIME: end })
      .then(function (r) {
        app.toast('Авария №' + props.alarm.ID + ' закрыта, длительность ' + r.item.LENGHT);
        app.bump();
        props.onDone();
      })
      .catch(function (err: ApiError) {
        setError(err.fields.END_TIME || err.message);
        setBusy(false);
      });
  }

  return (
    <Modal
      title={'Закрыть аварию №' + props.alarm.ID}
      onClose={props.onClose}
      size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>Закрыть аварию</button>
        </>
      }
    >
      <div className="modal-body">
        <p style={{ marginTop: 0 }}>
          <b>{props.alarm.SERV_ELEM}</b>
          <br />
          <span className="muted">Начало: {humanDateTime(props.alarm.BEGIN_TIME)}</span>
        </p>
        <Field label="Окончание" htmlFor="close-end" required error={error}>
          <div className="input-group">
            <DateTimeInput id="close-end" value={end} onChange={setEnd} invalid={!!error} maxNow />
            <button type="button" className="addon" onClick={function () { setEnd(nowWallMinute()); }}>Сейчас</button>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

