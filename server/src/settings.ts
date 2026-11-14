import crypto from 'node:crypto';
import { Router } from 'express';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { exec, select } from './db.js';
import { nowWall } from './clock.js';
import { requireAdmin } from './auth.js';
import { logAction } from './auditlog.js';
import { HttpError, str } from './http.js';

// Подключение к почтовому серверу компании.
// Приложение — обычный почтовый клиент: оно входит на корпоративный SMTP-сервер
// по адресу, порту, логину и паролю и отправляет письма от имени служебного ящика.
// Своего почтового сервера в приложении нет. Письма уходят только на внутренние
// адреса — домены из списка «разрешённые домены» (по умолчанию — домен отправителя).
//
// Значения из .env — начальные. Как только администратор сохранит настройки
// в интерфейсе, действуют они. Пароль хранится в БД зашифрованным
// (AES-256-GCM, ключ выводится из SETTINGS_SECRET или JWT_SECRET).

export type SmtpSecurity = 'auto' | 'starttls' | 'ssl' | 'none';
export type Source = 'ui' | 'env' | 'none';

export interface MailSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  password: string;
  fromName: string;
  fromAddress: string;
  tlsVerify: boolean;
  /** Домены, на которые разрешено отправлять, через запятую. Пусто — домен отправителя. */
  allowedDomains: string;
}

export const SECURITY_LABELS: Record<SmtpSecurity, string> = {
  auto: 'STARTTLS, если сервер поддерживает',
  starttls: 'STARTTLS',
  ssl: 'SSL/TLS',
  none: 'без шифрования',
};

const SECURITIES: SmtpSecurity[] = ['auto', 'starttls', 'ssl', 'none'];
export const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// ---------------------------------------------------------------- шифрование пароля

function secretKey(): Buffer {
  const base = process.env.SETTINGS_SECRET || process.env.JWT_SECRET || `${config.db.password}:${config.db.database}`;
  return crypto.createHash('sha256').update('webreport-settings\0' + base).digest();
}

function seal(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function unseal(sealed: string): string | null {
  if (!sealed) return '';
  try {
    const raw = Buffer.from(sealed.replace(/^v1:/, ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- значения из .env

function splitFrom(from: string): { name: string; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1].trim(), address: m[2].trim() };
  return { name: '', address: from.trim() };
}

function envMail(): MailSettings {
  const from = splitFrom(config.smtp.from);
  const sec = String(process.env.SMTP_SECURITY || '').toLowerCase() as SmtpSecurity;
  return {
    host: config.smtp.host,
    port: config.smtp.port,
    security: SECURITIES.indexOf(sec) >= 0 ? sec : config.smtp.secure ? 'ssl' : 'auto',
    user: config.smtp.user,
    password: config.smtp.password,
    fromName: from.name || 'Веб отчётность',
    fromAddress: from.address,
    tlsVerify: config.smtp.tlsVerify,
    allowedDomains: (process.env.MAIL_ALLOWED_DOMAINS || '').trim(),
  };
}

// ---------------------------------------------------------------- кеш настроек

let mail = { value: envMail(), source: (config.smtp.host ? 'env' : 'none') as Source, updatedAt: null as string | null, updatedBy: null as string | null, secretBroken: false };
let appUrl: { value: string; source: Source } = { value: config.appUrl, source: config.appUrl ? 'env' : 'none' };

export async function reloadSettings(): Promise<void> {
  const rows = await select<{ k: string; v: string; updated_at: string; updated_by: string | null }>('SELECT * FROM app_settings');
  const byKey = new Map(rows.map((r) => [r.k, r]));
  const m = byKey.get('mail');
  if (m) {
    const v = JSON.parse(m.v);
    const pwd = unseal(v.password || '');
    mail = {
      value: {
        host: v.host || '',
        port: Number(v.port) || 25,
        security: SECURITIES.indexOf(v.security) >= 0 ? v.security : 'auto',
        user: v.user || '',
        password: pwd || '',
        fromName: v.fromName || '',
        fromAddress: v.fromAddress || '',
        tlsVerify: v.tlsVerify !== false,
        allowedDomains: v.allowedDomains || '',
      },
      source: 'ui',
      updatedAt: m.updated_at,
      updatedBy: m.updated_by,
      secretBroken: pwd === null,
    };
    if (pwd === null) console.warn('[settings] пароль почты не расшифрован: сменился JWT_SECRET/SETTINGS_SECRET — введите его заново');
  }
  const u = byKey.get('app_url');
  if (u) appUrl = { value: JSON.parse(u.v).url || '', source: 'ui' };
}

async function store(key: string, value: unknown, by: string) {
  await exec(
    'INSERT INTO app_settings (k, v, updated_at, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)',
    [key, JSON.stringify(value), nowWall(), by],
  );
}

export function mailSettings(): MailSettings {
  return mail.value;
}

export function appUrlSetting(): string {
  return appUrl.value;
}

export function mailReady(): boolean {
  return !!mail.value.host && !!mail.value.fromAddress;
}

// ---------------------------------------------------------------- только внутренние адреса

/** Разрешённые домены получателей: из настроек или домен адреса отправителя. */
export function allowedDomains(s: MailSettings = mail.value): string[] {
  const list = s.allowedDomains.split(/[,;\s]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (list.length) return list;
  const at = s.fromAddress.lastIndexOf('@');
  return at > 0 ? [s.fromAddress.slice(at + 1).toLowerCase()] : [];
}

/** Адреса вне разрешённых доменов (поддомены разрешённого домена допустимы). */
export function externalAddresses(addresses: string[], s: MailSettings = mail.value): string[] {
  const domains = allowedDomains(s);
  if (!domains.length) return [];
  return addresses.filter((a) => {
    const d = a.slice(a.lastIndexOf('@') + 1).toLowerCase();
    return !domains.some((x) => d === x || d.endsWith('.' + x));
  });
}

// ---------------------------------------------------------------- SMTP-клиент

export function createMailer(s: MailSettings): Transporter {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'ssl',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
    // Без проверки сертификата допускаем и старые версии TLS — у старых серверов Exchange бывает только TLS 1.0.
    tls: s.tlsVerify ? { rejectUnauthorized: true } : { rejectUnauthorized: false, minVersion: 'TLSv1' },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

export function mailFrom(s: MailSettings) {
  return s.fromName ? { name: s.fromName, address: s.fromAddress } : s.fromAddress;
}

/** Переводит ошибку SMTP на понятный администратору язык; подробности сервера — в скобках. */
export function explainSmtpError(e: any, s: Pick<MailSettings, 'host' | 'port'>): string {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || e || '');
  const resp = e && e.response ? String(e.response).slice(0, 200) : '';
  const rc = e && e.responseCode ? Number(e.responseCode) : 0;
  const where = `${s.host}:${s.port}`;
  const tail = resp ? ` (ответ сервера: ${resp})` : msg ? ` (${msg.slice(0, 200)})` : '';

  if (code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(msg)) return `Сервер «${s.host}» не найден — проверьте адрес и DNS на сервере приложения`;
  if (/ECONNREFUSED/.test(msg) || code === 'ECONNREFUSED') return `Сервер ${where} отклонил соединение — проверьте порт; возможно, служба SMTP не слушает этот порт`;
  if (code === 'ETIMEDOUT' || /timeout|ETIMEDOUT/i.test(msg)) return `Нет ответа от ${where} за 10 секунд — проверьте адрес, порт и доступ с сервера приложения через межсетевой экран`;
  if (code === 'EAUTH' || rc === 535 || rc === 534) return `Сервер не принял логин или пароль${tail}`;
  if (rc === 530 || /authentication required|must issue a STARTTLS/i.test(resp)) {
    return /STARTTLS/i.test(resp) ? `Сервер требует шифрование — выберите STARTTLS${tail}` : `Сервер требует вход — укажите логин и пароль${tail}`;
  }
  if (/wrong version number|packet length too long|unknown protocol/i.test(msg)) {
    return 'Не совпадает тип шифрования: для порта 465 выберите SSL/TLS, для портов 25 и 587 — STARTTLS';
  }
  if (/self[- ]signed|certificate|unable to verify|CERT_|altnames/i.test(msg)) {
    return `Сертификат почтового сервера не прошёл проверку — снимите «Проверять сертификат», если у сервера самоподписанный или внутренний сертификат (${msg.slice(0, 160)})`;
  }
  if (code === 'ETLS' || /STARTTLS/i.test(msg)) return `Сервер не поддерживает STARTTLS — выберите «STARTTLS, если сервер поддерживает» или «без шифрования»${tail}`;
  if (code === 'EENVELOPE' || rc === 550 || rc === 553 || rc === 554) {
    if (/send ?as|not allowed to send|sender|from/i.test(resp)) return `Сервер не разрешает отправлять от этого адреса — адрес отправителя должен совпадать с ящиком учётной записи${tail}`;
    if (/relay/i.test(resp)) return `Сервер не пересылает почту на эти адреса без входа — укажите логин и пароль${tail}`;
    return `Сервер не принял отправителя или получателя${tail}`;
  }
  if (code === 'ESOCKET' || code === 'ECONNECTION') return `Соединение с ${where} прервано${tail}`;
  return (msg || 'Неизвестная ошибка').slice(0, 300);
}

// ---------------------------------------------------------------- ввод из формы

function readMail(b: any, current: MailSettings): MailSettings {
  const errors: Record<string, string> = {};
  const host = str(b?.host);
  const port = Number(str(b?.port) || 0);
  const security = str(b?.security) as SmtpSecurity;
  const user = str(b?.user);
  const fromName = str(b?.fromName);
  const fromAddress = str(b?.fromAddress);
  if (host && !HOST_RE.test(host)) errors.host = 'Имя или IP-адрес сервера, например mail.motiv.ru';
  if (host && (!Number.isInteger(port) || port < 1 || port > 65535)) errors.port = 'Порт от 1 до 65535';
  if (SECURITIES.indexOf(security) < 0) errors.security = 'Выберите шифрование';
  if (user.length > 190) errors.user = 'Не длиннее 190 символов';
  if (fromName.length > 120 || /[<>"]/.test(fromName)) errors.fromName = 'До 120 символов, без кавычек и угловых скобок';
  if (host && !fromAddress) errors.fromAddress = 'Укажите адрес, от имени которого уходят письма';
  else if (fromAddress && !EMAIL_RE.test(fromAddress)) errors.fromAddress = 'Адрес вида webreport@motiv.ru';
  const domains = str(b?.allowedDomains).toLowerCase().split(/[,;\s]+/).map((d) => d.replace(/^@/, '')).filter(Boolean);
  if (domains.some((d) => !DOMAIN_RE.test(d))) errors.allowedDomains = 'Домены через запятую, например motiv.ru, e2000.local';
  // Пароль: новый — если введён; «clearPassword» — удалить; иначе остаётся сохранённый.
  let password = current.password;
  if (b?.clearPassword === true) password = '';
  else if (typeof b?.password === 'string' && b.password !== '') password = b.password;
  if (password.length > 500) errors.password = 'Слишком длинный пароль';
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);
  return { host, port: port || 25, security, user, password, fromName, fromAddress, tlsVerify: b?.tlsVerify !== false, allowedDomains: domains.join(', ') };
}

// ---------------------------------------------------------------- состояние для интерфейса

export function settingsView() {
  const m = mail.value;
  return {
    mail: {
      host: m.host,
      port: m.port,
      security: m.security,
      user: m.user,
      hasPassword: !!m.password,
      fromName: m.fromName,
      fromAddress: m.fromAddress,
      tlsVerify: m.tlsVerify,
      allowedDomains: m.allowedDomains,
      effectiveDomains: allowedDomains(m),
      ready: mailReady(),
      source: m.host ? mail.source : 'none',
      updatedAt: mail.updatedAt,
      updatedBy: mail.updatedBy,
      secretBroken: mail.secretBroken,
    },
    appUrl: { value: appUrl.value, source: appUrl.source },
  };
}

// ---------------------------------------------------------------- маршруты (/api/notify/settings)

export const settingsRouter = Router();

settingsRouter.get('/', requireAdmin, (_req, res) => {
  res.json(settingsView());
});

settingsRouter.put('/mail', requireAdmin, async (req, res) => {
  const before = mail.value;
  const next = readMail(req.body, before);
  await store('mail', Object.assign({}, next, { password: seal(next.password) }), req.user!.login);
  await reloadSettings();
  const changes: Record<string, unknown> = {};
  for (const k of ['host', 'port', 'security', 'user', 'fromName', 'fromAddress', 'tlsVerify', 'allowedDomains'] as const) {
    if (String(before[k]) !== String(next[k])) changes[k] = [before[k], next[k]];
  }
  if (before.password !== next.password) changes.password = next.password ? 'изменён' : 'удалён';
  await logAction(req.user!, 'settings_mail', null, changes);
  res.json(settingsView());
});

settingsRouter.put('/app-url', requireAdmin, async (req, res) => {
  const url = str(req.body?.url).replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) {
    throw new HttpError(400, 'Проверьте поля', { url: 'Адрес вида https://report.motiv.local' });
  }
  const before = appUrl.value;
  await store('app_url', { url }, req.user!.login);
  await reloadSettings();
  await logAction(req.user!, 'settings_app_url', null, { url: [before, url] });
  res.json(settingsView());
});

/**
 * Проверка подключения к почтовому серверу по значениям из формы, ещё до сохранения:
 * соединение, шифрование, вход; если указан адрес — отправка проверочного письма.
 */
settingsRouter.post('/mail/test', requireAdmin, async (req, res) => {
  const s = readMail(req.body, mail.value);
  if (!s.host) throw new HttpError(400, 'Проверьте поля', { host: 'Укажите адрес почтового сервера' });
  const to = str(req.body?.to);
  if (to && !EMAIL_RE.test(to)) throw new HttpError(400, 'Проверьте поля', { to: 'Адрес вида name@motiv.ru' });
  if (to && externalAddresses([to], s).length) {
    throw new HttpError(400, 'Проверьте поля', { to: 'Отправка только на внутренние адреса: ' + allowedDomains(s).join(', ') });
  }
  const steps: Array<{ ok: boolean; text: string }> = [];
  const t = createMailer(s);
  try {
    await t.verify();
    steps.push({ ok: true, text: `Соединение с ${s.host}:${s.port} установлено, шифрование: ${SECURITY_LABELS[s.security]}` });
    steps.push({ ok: true, text: s.user ? `Вход выполнен под учётной записью ${s.user}` : 'Сервер принимает письма без входа' });
  } catch (e) {
    steps.push({ ok: false, text: explainSmtpError(e, s) });
    t.close();
    return res.json({ ok: false, steps });
  }
  if (to) {
    try {
      const info = await t.sendMail({
        from: mailFrom(s),
        to,
        subject: 'Веб отчётность: проверка почты',
        text: `Это проверочное письмо. Почтовый сервер ${s.host}:${s.port} настроен верно — уведомления об авариях будут приходить так же.\n\nОтправил: ${req.user!.full_name || req.user!.login}, ${nowWall()}.`,
      });
      const rejected = (info.rejected || []).map(String);
      if (rejected.length) steps.push({ ok: false, text: `Сервер не принял адрес ${rejected.join(', ')}` });
      else steps.push({ ok: true, text: `Письмо на ${to} принято сервером${info.response ? ` (${String(info.response).slice(0, 120)})` : ''}` });
    } catch (e) {
      steps.push({ ok: false, text: explainSmtpError(e, s) });
    }
  }
  t.close();
  await logAction(req.user!, 'settings_mail_test', null, { host: s.host, port: s.port, to: to || null, ok: steps.every((x) => x.ok) });
  res.json({ ok: steps.every((x) => x.ok), steps });
});
