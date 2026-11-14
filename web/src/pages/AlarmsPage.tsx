import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api, qs } from '../api';
import type { Alarm } from '../types';
import { OpenBoard } from '../components/OpenBoard';
import { AlarmEditor, CloseDialog } from '../components/AlarmEditor';
import { AlarmForm, draftToPayload, emptyDraft, validateDraft, type Draft } from '../components/AlarmForm';
import { IconCheck, IconPlus } from '../components/Icons';
import { formatBs } from '../../../shared/dict';
import { humanDateTime } from '../../../shared/time';

const DRAFT_KEY = 'webreport.newAlarmDraft';

function loadStoredDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return Object.assign(emptyDraft(), JSON.parse(raw));
  } catch (e) {
    return null;
  }
}

function storeDraft(d: Draft | null) {
  try {
    if (d) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch (e) {
    /* хранилище недоступно — черновик просто не сохранится */
  }
}

function isEmptyDraft(d: Draft): boolean {
  const e = emptyDraft();
  return Object.keys(e).every(function (k) {
    return (d as any)[k] === (e as any)[k];
  });
}

export function AlarmsPage(props: {
  open: Alarm[] | null;
  seedDraft: Draft | null;
  onSeedConsumed: () => void;
  onCopy: (d: Draft) => void;
}) {
  const app = useApp();
  const [editId, setEditId] = useState<number | null>(null);
  const [closing, setClosing] = useState<Alarm | null>(null);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Аварии</h1>
          <p>Внесение аварий на базовых станциях и контроль открытых</p>
        </div>
      </div>


      {app.canEdit ? (
        <NewAlarmPanel seedDraft={props.seedDraft} onSeedConsumed={props.onSeedConsumed} />
      ) : (
        <div className="panel">
          <div className="panel-body muted">
            Внесение аварий доступно дежурным и администраторам. Ваша роль — {app.meta.dict.roles[app.user.role]}: просмотр, отчёты и выгрузка CSV.
          </div>
        </div>
      )}

      <OpenBoard items={props.open} onOpen={setEditId} onCloseAlarm={setClosing} />

      <RecentPanel onOpen={setEditId} />

      {editId !== null ? (
        <AlarmEditor
          alarmId={editId}
          onClose={function () { setEditId(null); }}
          onCopy={function (d) {
            setEditId(null);
            props.onCopy(d);
          }}
        />
      ) : null}
      {closing ? (
        <CloseDialog alarm={closing} onClose={function () { setClosing(null); }} onDone={function () { setClosing(null); }} />
      ) : null}
    </div>
  );
}

function NewAlarmPanel(props: { seedDraft: Draft | null; onSeedConsumed: () => void }) {
  const app = useApp();
  const [draft, setDraftState] = useState<Draft>(function () {
    return props.seedDraft || loadStoredDraft() || emptyDraft();
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLElement>(null);

  function setDraft(d: Draft) {
    setDraftState(d);
    storeDraft(isEmptyDraft(d) ? null : d);
  }

  useEffect(
    function () {
      if (!props.seedDraft) return;
      setDraft(props.seedDraft);
      setErrors({});
      props.onSeedConsumed();
      if (panelRef.current) panelRef.current.scrollIntoView();
      app.toast('Поля скопированы. Укажите начало и сохраните аварию.');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [props.seedDraft],
  );

  function save(keepSimilar: boolean) {
    const e = validateDraft(draft);
    setErrors(e);
    if (Object.keys(e).length) {
      app.toast('Проверьте выделенные поля', 'err');
      return;
    }
    setBusy(true);
    api
      .post<{ item: Alarm }>('/api/alarms', draftToPayload(draft))
      .then(function (r) {
        app.toast('Авария №' + r.item.ID + ' внесена' + (r.item.IS_OPEN ? ', окончание — НВ' : ''));
        app.bump();
        if (keepSimilar) {
          // Для массовой аварии: причина и время те же, объект — новый.
          const next = Object.assign({}, draft, { SERV_ELEM: '', NUMB_RBS: '', EQIP_TYPE: '' });
          setDraft(next);
          const el = document.getElementById('new-SERV');
          if (el) el.focus();
        } else {
          setDraft(emptyDraft());
        }
        setErrors({});
      })
      .catch(function (err: ApiError) {
        setErrors(err.fields);
        app.toast(err.message, 'err');
      })
      .then(function () {
        setBusy(false);
      });
  }

  const dirty = !isEmptyDraft(draft);
  return (
    <section
      className="panel"
      ref={panelRef}
      aria-label="Новая авария"
      onKeyDown={function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          save(false);
        }
      }}
    >
      <div className="panel-head">
        <h2>Новая авария</h2>
        <span className="hint">Поля со звёздочкой обязательны; длительность и общий простой считаются сами</span>
      </div>
      <AlarmForm draft={draft} onChange={setDraft} errors={errors} idPrefix="new-" />
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={function () { save(false); }} disabled={busy}>
          <IconCheck />
          Сохранить аварию
        </button>
        <button type="button" className="btn" onClick={function () { save(true); }} disabled={busy}
          title="Сохранить и оставить причину, время и описание — для следующей БС этой же аварии">
          <IconPlus />
          Сохранить и внести похожую
        </button>
        <button type="button" className="btn btn-ghost" disabled={!dirty || busy}
          onClick={function () {
            setDraft(emptyDraft());
            setErrors({});
          }}>
          Очистить форму
        </button>
        <span className="note">
          <span className="kbd">Ctrl</span> + <span className="kbd">Enter</span> — сохранить.
          {dirty ? ' Черновик сохраняется в браузере.' : ''}
        </span>
      </div>
    </section>
  );
}

function RecentPanel(props: { onOpen: (id: number) => void }) {
  const app = useApp();
  const [items, setItems] = useState<Alarm[] | null>(null);
  const [error, setError] = useState('');

  useEffect(
    function () {
      api
        .get<{ items: Alarm[] }>('/api/alarms' + qs({ sort: 'id', dir: 'desc', pageSize: 10 }))
        .then(function (r) {
          setItems(r.items);
          setError('');
        })
        .catch(function (e: ApiError) {
          setError(e.message);
        });
    },
    [app.version],
  );

  return (
    <section className="panel" aria-label="Последние внесённые">
      <div className="panel-head">
        <h2>Последние внесённые</h2>
        <a href="#/reports" className="hint">Все аварии за период — во вкладке «Отчётность»</a>
      </div>
      {error ? <div className="panel-body"><div className="alert alert-err">{error}</div></div> : null}
      {items && !items.length ? (
        <div className="empty">
          <b>Аварий пока нет</b>
          Заполните форму выше — запись появится здесь.
        </div>
      ) : null}
      {items && items.length ? (
        <div className="table-wrap free">
          <table className="data">
            <thead>
              <tr>
                <th className="num">№</th>
                <th>Начало</th>
                <th>Окончание</th>
                <th>Длительность</th>
                <th>ТЦ</th>
                <th>Кат.</th>
                <th>Тип</th>
                <th>Сетевой элемент</th>
                <th className="num">БС</th>
                <th>Описание</th>
              </tr>
            </thead>
            <tbody>
              {items.map(function (a) {
                return (
                  <tr key={a.ID} className={'clickable' + (a.IS_OPEN ? ' open' : '')} tabIndex={0}
                    onClick={function () { props.onOpen(a.ID); }}
                    onKeyDown={function (e) { if (e.key === 'Enter') props.onOpen(a.ID); }}>
                    <td className="num">{a.ID}</td>
                    <td className="t">{humanDateTime(a.BEGIN_TIME)}</td>
                    <td className="t">{a.IS_OPEN ? <span className="tag tag-open">НВ</span> : humanDateTime(a.END_TIME)}</td>
                    <td className={'t' + (a.IS_OPEN ? ' live' : '')}>{a.LENGHT}</td>
                    <td>{a.TEHC || a.NAPR}</td>
                    <td><span className={'tag tag-k' + a.KATEG}>{a.KATEG}</span></td>
                    <td>{a.ALARM_TYPE}</td>
                    <td className="clip-l" title={a.SERV_ELEM || ''}>{a.SERV_ELEM}</td>
                    <td className="num">{formatBs(a.NUMB_RBS)}</td>
                    <td className="clip" title={a.DESCR || ''}>{a.DESCR}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
