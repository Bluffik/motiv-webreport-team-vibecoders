import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import type { Meta, User } from '../types';
import { Field } from '../components/Field';

const DEMO = [
  { login: 'admin', password: 'admin', role: 'Администратор' },
  { login: 'duty', password: 'duty', role: 'Дежурный' },
  { login: 'engineer', password: 'engineer', role: 'Инженер' },
];

export function LoginPage(props: { meta: Meta | null; onLogin: (u: User) => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function submit(e?: FormEvent, creds?: { login: string; password: string }) {
    if (e) e.preventDefault();
    const l = creds ? creds.login : login;
    const p = creds ? creds.password : password;
    if (!l || !p) {
      setError('Введите логин и пароль');
      return;
    }
    setBusy(true);
    setError('');
    api
      .post<{ user: User }>('/api/auth/login', { login: l, password: p })
      .then(function (r) {
        props.onLogin(r.user);
      })
      .catch(function (err: ApiError) {
        setError(err.message);
        setBusy(false);
      });
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-brand">
          <img src="/motiv-logo-white.svg" alt="Мотив" />
          <h1>Веб отчётность</h1>
          <p>Учёт аварий на базовых станциях</p>
        </div>
        <form className="login-form" onSubmit={submit} noValidate>
          <h2>Вход в систему</h2>
          <Field label="Логин" htmlFor="login">
            <input id="login" className="input" value={login} autoComplete="username" autoFocus
              onChange={function (e) { setLogin(e.target.value); }} />
          </Field>
          <Field label="Пароль" htmlFor="password">
            <input id="password" className="input" type="password" value={password} autoComplete="current-password"
              onChange={function (e) { setPassword(e.target.value); }} />
          </Field>
          {error ? <div className="alert alert-err" style={{ marginTop: 14 }} role="alert">{error}</div> : null}
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Вход…' : 'Войти'}
          </button>
          {props.meta && props.meta.demo ? (
            <div className="demo-accounts">
              <span className="muted">Демо-режим. Войти как:</span>
              <table>
                <tbody>
                  {DEMO.map(function (d) {
                    return (
                      <tr key={d.login}>
                        <td>{d.role}</td>
                        <td className="muted">{d.login} / {d.password}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button type="button" className="btn-link" disabled={busy}
                            onClick={function () { submit(undefined, d); }}>
                            Войти
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}
