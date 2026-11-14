import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, onUnauthorized } from './api';
import { syncServerTime } from './clock';
import { AppProvider, useApp } from './context';
import type { AdminTab, Alarm, Meta, Tab, User } from './types';
import { LoginPage } from './pages/LoginPage';
import { AlarmsPage } from './pages/AlarmsPage';
import { ReportsPage } from './pages/ReportsPage';
import { StatsPage } from './pages/StatsPage';
import { StationsPage } from './pages/StationsPage';
import { AdminPage } from './pages/AdminPage';
import type { Draft } from './components/AlarmForm';
import { AlarmEditor } from './components/AlarmEditor';
import { Field } from './components/Field';
import { Modal } from './components/Modal';
import { IconKey, IconLogout } from './components/Icons';

const TABS: Array<{ key: Tab; label: string; admin?: boolean }> = [
  { key: 'alarms', label: 'Аварии' },
  { key: 'reports', label: 'Отчётность' },
  { key: 'stats', label: 'Статистика' },
  { key: 'stations', label: 'Инвентарь БС' },
  { key: 'admin', label: 'Администрирование', admin: true },
];

const ADMIN_TABS: AdminTab[] = ['users', 'dicts', 'notify', 'trash', 'api', 'audit'];

interface Route {
  tab: Tab;
  admin: AdminTab;
  /** #/alarm/123 — ссылка из уведомления: открыть аварию поверх вкладки «Аварии». */
  alarmId: number | null;
}

function routeFromHash(): Route {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  const r: Route = { tab: 'alarms', admin: 'users', alarmId: null };
  if (parts[0] === 'alarm' && /^\d+$/.test(parts[1] || '')) {
    r.alarmId = +parts[1];
    return r;
  }
  // Старые адреса #/users и #/audit ведут в раздел администрирования.
  if (parts[0] === 'users' || parts[0] === 'audit') {
    r.tab = 'admin';
    r.admin = parts[0] as AdminTab;
    return r;
  }
  for (let i = 0; i < TABS.length; i++) if (TABS[i].key === parts[0]) r.tab = TABS[i].key;
  if (r.tab === 'admin' && ADMIN_TABS.indexOf(parts[1] as AdminTab) >= 0) r.admin = parts[1] as AdminTab;
  return r;
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [bootError, setBootError] = useState('');

  const reloadMeta = useCallback(function () {
    api.get<Meta>('/api/meta').then(function (m) {
      syncServerTime(m.serverNow);
      setMeta(m);
    }).catch(function () {
      /* останутся прежние справочники */
    });
  }, []);

  useEffect(function () {
    onUnauthorized(function () {
      setUser(null);
    });
    api
      .get<Meta>('/api/meta')
      .then(function (m) {
        syncServerTime(m.serverNow);
        setMeta(m);
        document.title = m.appName;
        return api.get<{ user: User }>('/api/auth/me').then(
          function (r) { setUser(r.user); },
          function () { setUser(null); },
        );
      })
      .catch(function (e: ApiError) {
        setBootError(e.message);
      });
  }, []);

  if (bootError) {
    return (
      <div className="splash">
        <div className="alert alert-err">Не удалось загрузить приложение: {bootError}</div>
      </div>
    );
  }
  if (!meta || user === undefined) return <div className="splash">Загрузка…</div>;
  if (!user) return <LoginPage meta={meta} onLogin={setUser} />;

  return (
    <AppProvider meta={meta} user={user} reloadMeta={reloadMeta}>
      <Shell onLogout={function () { setUser(null); }} />
    </AppProvider>
  );
}

function Shell(props: { onLogout: () => void }) {
  const app = useApp();
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [open, setOpen] = useState<Alarm[] | null>(null);
  const [seedDraft, setSeedDraft] = useState<Draft | null>(null);
  const [pwOpen, setPwOpen] = useState(false);

  useEffect(function () {
    function onHash() {
      const next = routeFromHash();
      setRoute(function (prev) {
        if (prev.tab !== next.tab || prev.admin !== next.admin) window.scrollTo(0, 0);
        return next;
      });
    }
    window.addEventListener('hashchange', onHash);
    return function () {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  // Открытые аварии: при изменениях данных и раз в 30 секунд.
  const loadOpen = useCallback(function () {
    api
      .get<{ items: Alarm[]; serverNow: string }>('/api/alarms/open')
      .then(function (r) {
        syncServerTime(r.serverNow);
        setOpen(r.items);
      })
      .catch(function () {
        /* табло обновится при следующей попытке */
      });
  }, []);
  useEffect(
    function () {
      loadOpen();
      const id = window.setInterval(loadOpen, 30000);
      return function () {
        window.clearInterval(id);
      };
    },
    [loadOpen, app.version],
  );

  const visibleTabs = TABS.filter(function (t) {
    return !t.admin || app.isAdmin;
  });
  const current = visibleTabs.some(function (t) { return t.key === route.tab; }) ? route.tab : 'alarms';

  function copyToNew(d: Draft) {
    setSeedDraft(d);
    window.location.hash = '#/alarms';
  }

  function logout() {
    api.post('/api/auth/logout').then(props.onLogout, props.onLogout);
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/alarms" aria-label="Веб отчётность — на главную">
            <img src="/motiv-logo.svg" alt="Мотив" width="128" height="30" />
            <span className="brand-name">Веб отчётность</span>
          </a>
          <nav className="tabs" aria-label="Разделы">
            {visibleTabs.map(function (t) {
              return (
                <a key={t.key} href={'#/' + (t.key === 'admin' ? 'admin/' + route.admin : t.key)} className={'tab' + (current === t.key ? ' active' : '')}
                  aria-current={current === t.key ? 'page' : undefined}>
                  {t.label}
                  {t.key === 'alarms' && open && open.length ? (
                    <span className="count" title="Открытые аварии">{open.length}</span>
                  ) : null}
                </a>
              );
            })}
          </nav>
          <div className="userbox">
            <div className="who">
              <b>{app.user.full_name || app.user.login}</b>
              <span>{app.meta.dict.roles[app.user.role]}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={function () { setPwOpen(true); }} title="Сменить пароль">
              <IconKey />
              <span className="visually-hidden">Сменить пароль</span>
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
              <IconLogout />
              Выйти
            </button>
          </div>
        </div>
      </header>

      <main>
        {current === 'alarms' ? (
          <AlarmsPage open={open} seedDraft={seedDraft} onSeedConsumed={function () { setSeedDraft(null); }} onCopy={copyToNew} />
        ) : null}
        {current === 'reports' ? <ReportsPage onCopy={copyToNew} /> : null}
        {current === 'stats' ? <StatsPage onCopy={copyToNew} /> : null}
        {current === 'stations' ? <StationsPage onCopy={copyToNew} /> : null}
        {current === 'admin' ? <AdminPage tab={route.admin} /> : null}
      </main>

      {route.alarmId !== null ? (
        <AlarmEditor alarmId={route.alarmId}
          onClose={function () { window.location.hash = '#/alarms'; }}
          onCopy={copyToNew} />
      ) : null}

      {pwOpen ? <PasswordDialog onClose={function () { setPwOpen(false); }} /> : null}
    </>
  );
}

function PasswordDialog(props: { onClose: () => void }) {
  const app = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function save() {
    if (next !== repeat) {
      setErrors({ repeat: 'Пароли не совпадают' });
      return;
    }
    setBusy(true);
    api
      .post('/api/auth/password', { current: current, next: next })
      .then(function () {
        app.toast('Пароль изменён');
        props.onClose();
      })
      .catch(function (e: ApiError) {
        setErrors(e.fields);
        app.toast(e.message, 'err');
        setBusy(false);
      });
  }

  return (
    <Modal title="Смена пароля" onClose={props.onClose} size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>Сменить пароль</button>
        </>
      }>
      <div className="modal-body">
        <div className="grid">
          <Field label="Текущий пароль" htmlFor="pw-cur" className="c-12" error={errors.current}>
            <input id="pw-cur" className="input" type="password" value={current} autoComplete="current-password"
              onChange={function (e) { setCurrent(e.target.value); }} />
          </Field>
          <Field label="Новый пароль" htmlFor="pw-new" className="c-12" error={errors.next} help="Не короче 6 символов">
            <input id="pw-new" className="input" type="password" value={next} autoComplete="new-password"
              onChange={function (e) { setNext(e.target.value); }} />
          </Field>
          <Field label="Повторите новый пароль" htmlFor="pw-rep" className="c-12" error={errors.repeat}>
            <input id="pw-rep" className="input" type="password" value={repeat} autoComplete="new-password"
              onChange={function (e) { setRepeat(e.target.value); }} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
