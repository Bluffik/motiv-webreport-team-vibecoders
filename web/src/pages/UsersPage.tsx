import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api } from '../api';
import type { UserRow } from '../types';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { IconPlus } from '../components/Icons';
import { ROLES, type Role } from '../../../shared/dict';
import { humanDateTime } from '../../../shared/time';

interface Form {
  login: string;
  full_name: string;
  role: Role | '';
  password: string;
  is_active: boolean;
}

export function UsersPage() {
  const app = useApp();
  const [items, setItems] = useState<UserRow[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(
    function () {
      api
        .get<{ items: UserRow[] }>('/api/users')
        .then(function (r) { setItems(r.items); })
        .catch(function (e: ApiError) { setError(e.message); });
    },
    [reload],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Пользователи</h1>
          <p>Учётные записи и роли доступа</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={function () { setEditing('new'); }}>
          <IconPlus />
          Добавить пользователя
        </button>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Роли</h2>
        </div>
        <div className="table-wrap free">
          <table className="data">
            <tbody>
              {ROLES.map(function (r) {
                return (
                  <tr key={r}>
                    <td style={{ width: 160 }}><span className={'tag tag-role-' + r}>{app.meta.dict.roles[r]}</span></td>
                    <td>{app.meta.dict.roleHints[r]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        {error ? <div className="panel-body"><div className="alert alert-err">{error}</div></div> : null}
        {items ? (
          <div className="table-wrap free">
            <table className="data">
              <thead>
                <tr>
                  <th>Логин</th>
                  <th>ФИО</th>
                  <th>Роль</th>
                  <th>Состояние</th>
                  <th>Последний вход</th>
                  <th>Создан</th>
                </tr>
              </thead>
              <tbody>
                {items.map(function (u) {
                  return (
                    <tr key={u.id} className="clickable" tabIndex={0}
                      onClick={function () { setEditing(u); }}
                      onKeyDown={function (e) { if (e.key === 'Enter') setEditing(u); }}>
                      <td><b>{u.login}</b>{u.id === app.user.id ? <span className="muted"> (вы)</span> : null}</td>
                      <td>{u.full_name}</td>
                      <td><span className={'tag tag-role-' + u.role}>{app.meta.dict.roles[u.role]}</span></td>
                      <td>{u.is_active ? 'Активен' : <span className="tag tag-off">Отключён</span>}</td>
                      <td className="t">{u.last_login_at ? humanDateTime(u.last_login_at) : <span className="faint">не входил</span>}</td>
                      <td className="t">{humanDateTime(u.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {editing ? (
        <UserDialog
          user={editing === 'new' ? null : editing}
          onClose={function () { setEditing(null); }}
          onSaved={function () {
            setEditing(null);
            setReload(reload + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function UserDialog(props: { user: UserRow | null; onClose: () => void; onSaved: () => void }) {
  const app = useApp();
  const u = props.user;
  const isSelf = !!u && u.id === app.user.id;
  const [f, setF] = useState<Form>({
    login: u ? u.login : '',
    full_name: u ? u.full_name : '',
    role: u ? u.role : '',
    password: '',
    is_active: u ? u.is_active : true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  function set(patch: Partial<Form>) {
    setF(Object.assign({}, f, patch));
  }

  function save() {
    setBusy(true);
    const req = u
      ? api.put('/api/users/' + u.id, { full_name: f.full_name, role: f.role, is_active: f.is_active, password: f.password })
      : api.post('/api/users', { login: f.login, full_name: f.full_name, role: f.role, password: f.password });
    req
      .then(function () {
        app.toast(u ? 'Пользователь ' + u.login + ' сохранён' : 'Пользователь ' + f.login + ' создан');
        props.onSaved();
      })
      .catch(function (e: ApiError) {
        setErrors(e.fields);
        app.toast(e.message, 'err');
        setBusy(false);
      });
  }

  function remove() {
    if (!u || !window.confirm('Удалить пользователя ' + u.login + '? Его записи в журнале сохранятся.')) return;
    setBusy(true);
    api
      .del('/api/users/' + u.id)
      .then(function () {
        app.toast('Пользователь ' + u.login + ' удалён');
        props.onSaved();
      })
      .catch(function (e: ApiError) {
        app.toast(e.message, 'err');
        setBusy(false);
      });
  }

  return (
    <Modal
      title={u ? 'Пользователь ' + u.login : 'Новый пользователь'}
      onClose={props.onClose}
      size="narrow"
      footer={
        <>
          {u && !isSelf ? <button type="button" className="btn btn-danger left" onClick={remove} disabled={busy}>Удалить</button> : null}
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {u ? 'Сохранить' : 'Создать пользователя'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="grid">
          <Field label="Логин" htmlFor="u-login" required className="c-12" error={errors.login} help={u ? undefined : 'Латиница, цифры, точка, дефис'}>
            <input id="u-login" className="input" value={f.login} disabled={!!u} autoComplete="off"
              onChange={function (e) { set({ login: e.target.value }); }} />
          </Field>
          <Field label="ФИО" htmlFor="u-name" required className="c-12" error={errors.full_name}>
            <input id="u-name" className="input" value={f.full_name} autoComplete="off"
              onChange={function (e) { set({ full_name: e.target.value }); }} placeholder="Иванов Иван Иванович" />
          </Field>
          <Field label="Роль" htmlFor="u-role" required className="c-12" error={errors.role}
            help={f.role ? app.meta.dict.roleHints[f.role as Role] : undefined}>
            <select id="u-role" className="select" value={f.role} disabled={isSelf}
              onChange={function (e) { set({ role: e.target.value as Role }); }}>
              <option value="" disabled>— выберите —</option>
              {ROLES.map(function (r) { return <option key={r} value={r}>{app.meta.dict.roles[r]}</option>; })}
            </select>
          </Field>
          <Field label={u ? 'Новый пароль' : 'Пароль'} htmlFor="u-pw" required={!u} className="c-12" error={errors.password}
            help={u ? 'Оставьте пустым, чтобы не менять' : 'Не короче 6 символов'}>
            <input id="u-pw" className="input" type="password" value={f.password} autoComplete="new-password"
              onChange={function (e) { set({ password: e.target.value }); }} />
          </Field>
          {u ? (
            <div className="c-12">
              <label className="check">
                <input type="checkbox" checked={f.is_active} disabled={isSelf}
                  onChange={function (e) { set({ is_active: e.target.checked }); }} />
                Учётная запись активна
              </label>
              {isSelf ? <div className="field-help">Свою роль и активность изменить нельзя.</div> : null}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
