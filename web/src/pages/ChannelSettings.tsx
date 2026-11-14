import { useEffect, useState } from 'react';
import { useApp } from '../context';
import { ApiError, api } from '../api';
import type { CheckResult, SettingSource, SettingsView, SmtpSecurity } from '../types';
import { Field } from '../components/Field';
import { Modal } from '../components/Modal';
import { humanDateTime } from '../../../shared/time';

// Подключение к почтовому серверу компании и адрес приложения для ссылок в письмах.
// Приложение — почтовый клиент: оно входит на корпоративный SMTP-сервер под служебной
// учётной записью. Письма уходят только на внутренние адреса компании.

const SECURITY_OPTIONS: Array<{ value: SmtpSecurity; label: string; port: number | null }> = [
  { value: 'starttls', label: 'STARTTLS — обычно порт 587', port: 587 },
  { value: 'ssl', label: 'SSL/TLS — обычно порт 465', port: 465 },
  { value: 'auto', label: 'STARTTLS, если сервер поддерживает — порт 25', port: 25 },
  { value: 'none', label: 'Без шифрования — внутренняя пересылка, порт 25', port: 25 },
];
const STANDARD_PORTS = ['25', '465', '587'];

function sourceText(source: SettingSource, at: string | null, by: string | null): string {
  if (source === 'env') return 'Значения из файла .env. Изменить можно здесь — тогда будут действовать настройки из интерфейса.';
  if (source === 'ui') return 'Настроено в интерфейсе' + (at ? ' ' + humanDateTime(at) : '') + (by ? ', ' + by : '');
  return '';
}

export function CheckSteps(props: { result: CheckResult | null; busy: boolean; label: string }) {
  if (props.busy) return <div className="check-steps busy" role="status">{props.label}</div>;
  if (!props.result) return null;
  return (
    <ul className="check-steps" role="status">
      {props.result.steps.map(function (s, i) {
        return (
          <li key={i} className={s.ok ? 'ok' : 'fail'}>
            <span className="mark" aria-hidden="true">{s.ok ? '✓' : '✕'}</span>
            <span className="visually-hidden">{s.ok ? 'Успешно: ' : 'Ошибка: '}</span>
            {s.text}
          </li>
        );
      })}
    </ul>
  );
}

export function ChannelsPanel(props: { onChanged: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<'mail' | 'url' | null>(null);

  function load() {
    api.get<SettingsView>('/api/notify/settings')
      .then(function (v) { setView(v); setError(''); })
      .catch(function (e: ApiError) { setError(e.message); });
  }
  useEffect(load, []);

  function saved(v: SettingsView) {
    setView(v);
    setDialog(null);
    props.onChanged();
  }

  if (error) return <div className="alert alert-err">{error}</div>;
  if (!view) return null;
  const m = view.mail;
  const sec = SECURITY_OPTIONS.filter(function (o) { return o.value === m.security; })[0];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Почтовый сервер</h2>
        <span className="hint">Через него уходят уведомления. Меняет только администратор</span>
      </div>
      <div className="channel">
        <div className="ch-head">
          <span className={'tag ' + (m.ready ? 'tag-st-sent' : 'tag-st-skipped')}>{m.ready ? 'подключён' : 'не подключён'}</span>
          <button type="button" className="btn btn-sm ch-btn" onClick={function () { setDialog('mail'); }}>
            {m.host ? 'Изменить' : 'Подключить'}
          </button>
        </div>
        {m.host ? (
          <dl className="ch-props">
            <dt>Сервер</dt>
            <dd>{m.host}:{m.port}, {sec ? sec.label.split(' — ')[0] : m.security}{m.tlsVerify ? '' : ', без проверки сертификата'}</dd>
            <dt>Вход</dt>
            <dd>{m.user ? m.user + (m.hasPassword ? ', пароль сохранён' : ', без пароля') : 'без входа (пересылка по IP)'}</dd>
            <dt>Отправитель</dt>
            <dd>{m.fromAddress ? (m.fromName ? m.fromName + ' <' + m.fromAddress + '>' : m.fromAddress) : <span className="txt-err">не указан</span>}</dd>
            <dt>Получатели</dt>
            <dd>{m.effectiveDomains.length ? 'только адреса @' + m.effectiveDomains.join(', @') : 'любые адреса'}</dd>
          </dl>
        ) : (
          <p>
            Письма уходят через почтовый сервер компании: приложение входит на него под служебной учётной записью,
            как обычный почтовый клиент, и отправляет только на внутренние адреса. Пока сервер не подключён,
            сообщения сохраняются в журнале ниже — их можно будет отправить повторно.
          </p>
        )}
        {m.secretBroken ? <p className="txt-err">Сохранённый пароль не расшифровать — введите его заново.</p> : null}
        {m.host ? <p className="ch-src">{sourceText(m.source, m.updatedAt, m.updatedBy)}</p> : null}
      </div>
      <div className="ch-url">
        <span className="muted">Ссылки в письмах ведут на</span>{' '}
        {view.appUrl.value ? <b>{view.appUrl.value}</b> : <span>адрес, по которому приложение открыли последним ({window.location.origin})</span>}
        <button type="button" className="btn btn-xs" onClick={function () { setDialog('url'); }}>Изменить</button>
      </div>

      {dialog === 'mail' ? <MailDialog view={view} onClose={function () { setDialog(null); }} onSaved={saved} /> : null}
      {dialog === 'url' ? <AppUrlDialog view={view} onClose={function () { setDialog(null); }} onSaved={saved} /> : null}
    </section>
  );
}

interface MailForm {
  host: string;
  port: string;
  security: SmtpSecurity;
  user: string;
  password: string;
  clearPassword: boolean;
  fromName: string;
  fromAddress: string;
  tlsVerify: boolean;
  allowedDomains: string;
}

function MailDialog(props: { view: SettingsView; onClose: () => void; onSaved: (v: SettingsView) => void }) {
  const app = useApp();
  const m = props.view.mail;
  const [f, setF] = useState<MailForm>({
    host: m.host,
    port: m.host ? String(m.port) : '587',
    security: m.host ? m.security : 'starttls',
    user: m.user,
    password: '',
    clearPassword: false,
    fromName: m.fromName || 'Веб отчётность',
    fromAddress: m.fromAddress,
    tlsVerify: m.tlsVerify,
    allowedDomains: m.allowedDomains,
  });
  const [to, setTo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);

  function set(patch: Partial<MailForm>) {
    setF(Object.assign({}, f, patch));
    setCheck(null);
  }

  function setSecurity(v: SmtpSecurity) {
    const opt = SECURITY_OPTIONS.filter(function (o) { return o.value === v; })[0];
    const patch: Partial<MailForm> = { security: v };
    // Порт меняем вместе с шифрованием, только если он был стандартным.
    if (opt && opt.port && (STANDARD_PORTS.indexOf(f.port) >= 0 || !f.port)) patch.port = String(opt.port);
    set(patch);
  }

  function runCheck() {
    setChecking(true);
    setCheck(null);
    setErrors({});
    api.post<CheckResult>('/api/notify/settings/mail/test', Object.assign({}, f, { to: to }))
      .then(function (r) { setCheck(r); })
      .catch(function (e: ApiError) { setErrors(e.fields); if (!Object.keys(e.fields).length) app.toast(e.message, 'err'); })
      .then(function () { setChecking(false); });
  }

  function save() {
    setBusy(true);
    api.put<SettingsView>('/api/notify/settings/mail', f)
      .then(function (v) {
        app.toast(v.mail.ready ? 'Почтовый сервер подключён' : 'Настройки почты сохранены');
        props.onSaved(v);
      })
      .catch(function (e: ApiError) { setErrors(e.fields); app.toast(e.message, 'err'); setBusy(false); });
  }

  const pwdPlaceholder = f.clearPassword ? 'Пароль будет удалён' : m.hasPassword ? 'Сохранён — введите новый, чтобы заменить' : '';
  const fromDomain = f.fromAddress.indexOf('@') > 0 ? f.fromAddress.slice(f.fromAddress.indexOf('@') + 1) : '';

  return (
    <Modal title="Почтовый сервер для уведомлений" onClose={props.onClose} size="mid"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>Сохранить</button>
        </>
      }>
      <div className="modal-body">
        <p className="lead-note">
          Приложение отправляет письма через почтовый сервер компании, как обычный почтовый клиент: входит под служебной
          учётной записью и отправляет от её имени. Данные для подключения выдаёт администратор почты.
        </p>
        {m.source === 'env' ? (
          <div className="alert alert-info" style={{ marginBottom: 14 }}>
            Сейчас действуют значения из файла .env. После сохранения будут действовать настройки из этой формы.
          </div>
        ) : null}
        {m.secretBroken ? (
          <div className="alert alert-warn" style={{ marginBottom: 14 }}>Сохранённый пароль не удалось расшифровать — введите его заново.</div>
        ) : null}
        <div className="grid">
          <Field label="Адрес сервера" htmlFor="ms-host" required className="c-8" error={errors.host}
            help="Имя или IP-адрес SMTP-сервера, например mail.motiv.ru">
            <input id="ms-host" className="input" value={f.host} autoComplete="off" spellCheck={false} placeholder="mail.motiv.ru"
              onChange={function (e) { set({ host: e.target.value.trim() }); }} />
          </Field>
          <Field label="Порт" htmlFor="ms-port" required className="c-4" error={errors.port}>
            <input id="ms-port" className="input tnum" value={f.port} inputMode="numeric" autoComplete="off"
              onChange={function (e) { set({ port: e.target.value.replace(/\D/g, '').slice(0, 5) }); }} />
          </Field>
          <Field label="Шифрование" htmlFor="ms-sec" className="c-8" error={errors.security}>
            <select id="ms-sec" className="select" value={f.security}
              onChange={function (e) { setSecurity(e.target.value as SmtpSecurity); }}>
              {SECURITY_OPTIONS.map(function (o) { return <option key={o.value} value={o.value}>{o.label}</option>; })}
            </select>
          </Field>
          <div className="c-4 field checks-cell">
            <label className="check">
              <input type="checkbox" checked={f.tlsVerify} onChange={function (e) { set({ tlsVerify: e.target.checked }); }} />
              Проверять сертификат
            </label>
            <div className="field-help">Снимите для самоподписанного сертификата</div>
          </div>

          <Field label="Логин" htmlFor="ms-user" className="c-6" error={errors.user}
            help="Пусто — сервер принимает письма без входа (пересылка разрешена по IP)">
            <input id="ms-user" className="input" value={f.user} autoComplete="off" spellCheck={false} placeholder="webreport или webreport@motiv.ru"
              onChange={function (e) { set({ user: e.target.value.trim() }); }} />
          </Field>
          <Field label="Пароль" htmlFor="ms-pass" className="c-6" error={errors.password}
            aside={m.hasPassword ? (
              <button type="button" className="btn-link" onClick={function () { set({ clearPassword: !f.clearPassword, password: '' }); }}>
                {f.clearPassword ? 'Оставить сохранённый' : 'Удалить сохранённый'}
              </button>
            ) : undefined}
            help="Хранится в базе в зашифрованном виде и не показывается">
            <input id="ms-pass" className="input" type="password" value={f.password} autoComplete="new-password"
              placeholder={pwdPlaceholder} disabled={f.clearPassword}
              onChange={function (e) { set({ password: e.target.value }); }} />
          </Field>
          <Field label="Имя отправителя" htmlFor="ms-fname" className="c-6" error={errors.fromName}>
            <input id="ms-fname" className="input" value={f.fromName} autoComplete="off" placeholder="Веб отчётность"
              onChange={function (e) { set({ fromName: e.target.value }); }} />
          </Field>
          <Field label="Адрес отправителя" htmlFor="ms-from" required className="c-6" error={errors.fromAddress}
            help="Обычно совпадает с ящиком учётной записи">
            <input id="ms-from" className="input" value={f.fromAddress} autoComplete="off" spellCheck={false} placeholder="webreport@motiv.ru"
              onChange={function (e) { set({ fromAddress: e.target.value.trim() }); }} />
          </Field>
          <Field label="Разрешённые домены получателей" htmlFor="ms-domains" className="c-12" error={errors.allowedDomains}
            help={'Письма уходят только на внутренние адреса. Пусто — только домен отправителя' + (fromDomain ? ' (' + fromDomain + ')' : '')}>
            <input id="ms-domains" className="input" value={f.allowedDomains} autoComplete="off" spellCheck={false}
              placeholder={fromDomain || 'motiv.ru, e2000.local'}
              onChange={function (e) { set({ allowedDomains: e.target.value }); }} />
          </Field>
        </div>

        <div className="check-box">
          <div className="check-row">
            <Field label="Проверочное письмо на адрес" htmlFor="ms-to" className="grow" error={errors.to}
              help="Необязательно. Без адреса проверяются только соединение и вход">
              <input id="ms-to" className="input" value={to} autoComplete="off" spellCheck={false} placeholder={'name@' + (fromDomain || 'motiv.ru')}
                onChange={function (e) { setTo(e.target.value.trim()); setCheck(null); }} />
            </Field>
            <button type="button" className="btn" onClick={runCheck} disabled={checking || !f.host}>
              {to ? 'Проверить и отправить' : 'Проверить подключение'}
            </button>
          </div>
          <CheckSteps result={check} busy={checking} label={'Подключаюсь к ' + f.host + ':' + f.port + '…'} />
        </div>
      </div>
    </Modal>
  );
}

function AppUrlDialog(props: { view: SettingsView; onClose: () => void; onSaved: (v: SettingsView) => void }) {
  const app = useApp();
  const [url, setUrl] = useState(props.view.appUrl.value);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function save() {
    setBusy(true);
    api.put<SettingsView>('/api/notify/settings/app-url', { url: url })
      .then(function (v) { app.toast('Адрес для ссылок сохранён'); props.onSaved(v); })
      .catch(function (e: ApiError) { setError(e.fields.url || e.message); setBusy(false); });
  }

  return (
    <Modal title="Адрес приложения в ссылках" onClose={props.onClose} size="narrow"
      footer={
        <>
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>Сохранить</button>
        </>
      }>
      <div className="modal-body">
        <Field label="Адрес" htmlFor="au-url" error={error}
          aside={
            <button type="button" className="btn-link" onClick={function () { setUrl(window.location.origin); setError(''); }}>
              Подставить текущий
            </button>
          }
          help="На него ведут ссылки «Открыть аварию» в письмах. Пусто — адрес, по которому приложение открыли последним">
          <input id="au-url" className="input" value={url} autoComplete="off" spellCheck={false} placeholder="https://report.motiv.local"
            onChange={function (e) { setUrl(e.target.value.trim()); setError(''); }} />
        </Field>
      </div>
    </Modal>
  );
}
