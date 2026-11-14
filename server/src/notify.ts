import { Router, type Request } from 'express';
import { exec, select } from './db.js';
import { nowWall } from './clock.js';
import { requireAdmin, requireAuth } from './auth.js';
import { logAction, type ActorRef } from './auditlog.js';
import { dictItems, dictValues } from './dicts.js';
import { HttpError, intParam, str } from './http.js';
import {
  SECURITY_LABELS, allowedDomains, appUrlSetting, createMailer, explainSmtpError, externalAddresses, mailFrom, mailReady,
  mailSettings, settingsRouter, settingsView,
} from './settings.js';
import { buildDigest, type DigestMessage } from './digest.js';
import { formatBs, isSector } from '../../shared/dict.js';
import { OPEN_END_LABEL, ZERO_DATETIME, humanDateTime } from '../../shared/time.js';

// Автоуведомления об авариях по e-mail через почтовый сервер компании (приложение
// входит на него как обычный почтовый клиент; подключение — settings.ts).
// Получатели — только внутренние адреса компании. Если почта не подключена,
// сообщение всё равно попадает в журнал со статусом «не отправлено» — его видно
// и можно отправить повторно.

export type NotifyEvent = 'create' | 'close' | 'long' | 'test' | 'daily';
type AlarmEvent = Exclude<NotifyEvent, 'daily'>;
export type Channel = 'email';

export const EVENT_LABELS: Record<NotifyEvent, string> = {
  create: 'Новая авария',
  close: 'Авария закрыта',
  long: 'Авария затянулась',
  test: 'Проверка',
  daily: 'Ежедневная сводка',
};

/** Поля аварии, нужные для сообщения (как в rowToApi). */
export interface NotifyAlarm {
  ID: number;
  PW: string | null;
  NAPR: string | null;
  TEHC: string | null;
  KATEG: number | null;
  NETW_TYPE: string | null;
  SERV_ELEM: string | null;
  NUMB_RBS: string | null;
  ALARM_TYPE: string | null;
  DESCR: string | null;
  BEGIN_TIME: string | null;
  END_TIME: string | null;
  IS_OPEN: boolean;
  LENGHT: string | null;
  LENGTH_SEC: number | null;
  PROSTOY: string | null;
  COMMON_PROSTOY: string | null;
  AKB: string | null;
  DGU: string | null;
}

interface Rule {
  id: number;
  name: string;
  channel: Channel;
  target: string;
  kateg: string[];
  napr: string[];
  tehc: string[];
  alarm_types: string[];
  on_create: boolean;
  on_close: boolean;
  long_hours: number | null;
  /** Время ежедневной сводки 'ЧЧ:ММ' или null. */
  daily_at: string | null;
  is_active: boolean;
  created_at: string;
}

function list(v: string | null | undefined): string[] {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function mapRule(r: any): Rule {
  return {
    id: r.id,
    name: r.name,
    channel: r.channel,
    target: r.target,
    kateg: list(r.kateg),
    napr: list(r.napr),
    tehc: list(r.tehc),
    alarm_types: list(r.alarm_types),
    on_create: !!r.on_create,
    on_close: !!r.on_close,
    long_hours: r.long_hours === null || r.long_hours === undefined ? null : Number(r.long_hours),
    daily_at: r.daily_at || null,
    is_active: !!r.is_active,
    created_at: r.created_at,
  };
}

function matches(rule: Rule, a: NotifyAlarm): boolean {
  if (rule.kateg.length && rule.kateg.indexOf(String(a.KATEG)) < 0) return false;
  if (rule.napr.length && rule.napr.indexOf(a.NAPR || '') < 0) return false;
  if (rule.tehc.length && rule.tehc.indexOf(a.TEHC || '') < 0) return false;
  if (rule.alarm_types.length && rule.alarm_types.indexOf(a.ALARM_TYPE || '') < 0) return false;
  return true;
}

export function channelStatus() {
  const m = mailSettings();
  const v = settingsView();
  return {
    email: {
      configured: mailReady(),
      server: m.host ? `${m.host}:${m.port}` : '',
      security: SECURITY_LABELS[m.security],
      user: m.user,
      from: m.fromAddress ? (m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress) : '',
      source: v.mail.source,
      secretBroken: v.mail.secretBroken,
    },
    appUrl: v.appUrl,
  };
}

// ---------------------------------------------------------------- текст сообщения

function esc(s: unknown): string {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function typeLabel(code: string | null): string {
  if (!code) return '—';
  const item = dictItems('type').find((i) => i.value === code);
  return item && item.note ? `${code} (${item.note})` : code;
}

let lastOrigin = '';

/** Запоминает адрес, по которому открывают приложение, — для ссылок, если APP_URL не задан. */
export function rememberOrigin(req: Request) {
  const host = req.get('host');
  if (host) lastOrigin = `${req.protocol}://${host}`;
}

function linkBase(): string {
  return appUrlSetting() || lastOrigin;
}

function alarmLink(id: number): string {
  const base = linkBase();
  return base ? `${base}/#/alarm/${id}` : '';
}

interface Message {
  subject: string;
  text: string;
  html: string;
}

export function buildMessage(event: AlarmEvent, a: NotifyAlarm, rule: { name: string } | null, actor: string | null): Message {
  const where = a.TEHC ? `ТЦ ${a.TEHC}` : a.NAPR || '';
  const bs = isSector(a.NUMB_RBS) ? 'сектор' : `${formatBs(a.NUMB_RBS)} БС`;
  const head: Record<AlarmEvent, string> = {
    create: `Авария №${a.ID}, кат. ${a.KATEG}: ${a.ALARM_TYPE}, ${where}`,
    close: `Закрыта авария №${a.ID}, кат. ${a.KATEG}: ${a.ALARM_TYPE}, ${where}, длительность ${a.LENGHT}`,
    long: `Авария №${a.ID} продолжается ${a.LENGHT}: кат. ${a.KATEG}, ${a.ALARM_TYPE}, ${where}`,
    test: `Проверка уведомлений: авария №${a.ID}, кат. ${a.KATEG}, ${a.ALARM_TYPE}, ${where}`,
  };
  const subject = (head[event] + (a.SERV_ELEM ? ` — ${a.SERV_ELEM}` : '')).slice(0, 440);

  const rows: Array<[string, string]> = [
    ['Направление', a.NAPR || '—'],
    ['ТЦ', a.TEHC || '—'],
    ['Категория', String(a.KATEG ?? '—')],
    ['Тип', typeLabel(a.ALARM_TYPE)],
    ['Тип сети', a.NETW_TYPE || '—'],
    ['Сетевой элемент', a.SERV_ELEM || '—'],
    ['Количество БС', formatBs(a.NUMB_RBS) || '—'],
    ['Начало', humanDateTime(a.BEGIN_TIME)],
    ['Окончание', a.IS_OPEN ? `${OPEN_END_LABEL} — авария продолжается` : humanDateTime(a.END_TIME)],
    ['Длительность', a.LENGHT || '—'],
  ];
  if (a.PROSTOY) rows.push(['Перерыв связи', a.PROSTOY], ['Общий простой БС', a.COMMON_PROSTOY || '—']);
  if (a.AKB) rows.push(['АКБ', a.AKB]);
  if (a.DGU) rows.push(['ГУ', a.DGU]);
  rows.push(['Описание', a.DESCR || '—']);
  if (a.PW) rows.push(['Номер PW/NTT', a.PW]);

  const link = alarmLink(a.ID);
  const lead: Record<AlarmEvent, string> = {
    create: `Внесена авария${actor ? ` (${actor})` : ''}.`,
    close: `Авария закрыта${actor ? ` (${actor})` : ''}.`,
    long: 'Авария не закрыта дольше порога, заданного в правиле уведомлений.',
    test: 'Это проверочное сообщение: так будут выглядеть уведомления по этому правилу.',
  };
  const footer = rule ? `Правило уведомления: «${rule.name}». Веб отчётность.` : 'Веб отчётность.';

  const text = [
    head[event],
    '',
    lead[event],
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    link ? `Открыть: ${link}` : '',
    footer,
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');

  const accent = event === 'close' ? '#2e3135' : '#d6262f';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f2;font-family:Arial,Helvetica,sans-serif;color:#2e3135">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-top:4px solid #f37021">
<tr><td style="padding:20px 24px 8px"><div style="font-size:13px;color:${accent};font-weight:bold">${esc(EVENT_LABELS[event])}</div>
<div style="font-size:18px;font-weight:bold;margin-top:4px">${esc(head[event])}</div>
<div style="font-size:14px;margin-top:8px;color:#5b5f63">${esc(lead[event])}</div></td></tr>
<tr><td style="padding:8px 24px 16px"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;color:#707478;white-space:nowrap;vertical-align:top;border-bottom:1px solid #ebeced">${esc(k)}</td><td style="padding:5px 0;border-bottom:1px solid #ebeced">${esc(v)}</td></tr>`).join('\n')}
</table></td></tr>
${link ? `<tr><td style="padding:0 24px 20px"><a href="${esc(link)}" style="display:inline-block;background:#f37021;color:#ffffff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:4px">Открыть аварию №${a.ID}</a></td></tr>` : ''}
<tr><td style="padding:12px 24px;font-size:12px;color:#707478;border-top:1px solid #ebeced">${esc(footer)}</td></tr>
</table></body></html>`;

  return { subject, text, html };
}

// ---------------------------------------------------------------- отправка

async function sendEmail(target: string, m: Message): Promise<void> {
  const settings = mailSettings();
  const ext = externalAddresses(list(target.replace(/;/g, ',')), settings);
  if (ext.length) throw new Error(`Адреса вне компании не допускаются (${allowedDomains(settings).join(', ')}): ${ext.join(', ')}`);
  const t = createMailer(settings);
  try {
    await t.sendMail({
      from: mailFrom(settings),
      to: list(target.replace(/;/g, ',')).join(', '),
      subject: m.subject,
      text: m.text,
      html: m.html,
    });
  } catch (e) {
    throw new Error(explainSmtpError(e, settings));
  } finally {
    t.close();
  }
}

function notConfigured(channel: Channel): string | null {
  if (channel === 'email' && !mailReady()) return 'Почтовый сервер не подключён (Администрирование → Уведомления → E-mail)';
  return null;
}

async function deliver(logId: number, channel: Channel, target: string, m: Message): Promise<{ ok: boolean; error?: string }> {
  try {
    await sendEmail(target, m);
    await exec("UPDATE notify_log SET status = 'sent', error = NULL, sent_at = ? WHERE id = ?", [nowWall(), logId]);
    return { ok: true };
  } catch (e: any) {
    const error = String(e && e.message ? e.message : e).slice(0, 440);
    await exec("UPDATE notify_log SET status = 'failed', error = ? WHERE id = ?", [error, logId]);
    console.error(`[notify] ${channel} → ${target}: ${error}`);
    return { ok: false, error };
  }
}

interface SendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/** Записывает сообщение в журнал и отправляет его. Возвращает итог отправки. */
async function record(rule: Rule, event: NotifyEvent, alarmId: number | null, m: Message): Promise<SendResult> {
  const skip = notConfigured(rule.channel);
  const body = m.text;
  const r = await exec(
    `INSERT INTO notify_log (ts, rule_id, rule_name, alarm_id, event, channel, target, subject, body, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nowWall(), rule.id || null, rule.name, alarmId, event, rule.channel, rule.target, m.subject, body,
      skip ? 'skipped' : 'pending', skip],
  );
  if (skip) return { ok: false, skipped: true, error: skip };
  return deliver(r.insertId, rule.channel, rule.target, m);
}

function send(rule: Rule, event: AlarmEvent, a: NotifyAlarm, actor: string | null): Promise<SendResult> {
  return record(rule, event, a.ID || null, buildMessage(event, a, rule, actor));
}

function digestFor(rule: Rule, end: string, test: boolean): Promise<DigestMessage> {
  return buildDigest(rule, end, nowWall(), linkBase(), rule.name, test);
}

async function activeRules(): Promise<Rule[]> {
  return (await select('SELECT * FROM notify_rules WHERE is_active = 1 ORDER BY id')).map(mapRule);
}

/** Уведомления о новой или закрытой аварии. Не бросает ошибок — уведомления не должны ломать запись аварии. */
export async function notifyAlarm(event: 'create' | 'close', a: NotifyAlarm, actor: ActorRef | null): Promise<void> {
  try {
    const rules = (await activeRules()).filter((r) => (event === 'create' ? r.on_create : r.on_close) && matches(r, a));
    const who = actor ? actor.full_name || actor.login : null;
    for (const rule of rules) await send(rule, event, a, who);
  } catch (e) {
    console.error('[notify] не удалось разослать уведомления', e);
  }
}

/** Эскалация: открытая авария длится дольше порога правила. Вызывается раз в минуту. */
export async function checkLongAlarms(openAlarms: NotifyAlarm[]): Promise<void> {
  const rules = (await activeRules()).filter((r) => r.long_hours !== null && r.long_hours > 0);
  if (!rules.length || !openAlarms.length) return;
  const sentRows = await select(
    "SELECT rule_id, alarm_id FROM notify_log WHERE event = 'long' AND alarm_id IN (?)",
    [openAlarms.map((a) => a.ID)],
  );
  const sent = new Set(sentRows.map((r) => r.rule_id + ':' + r.alarm_id));
  for (const rule of rules) {
    for (const a of openAlarms) {
      if (a.LENGTH_SEC === null || a.LENGTH_SEC < (rule.long_hours as number) * 3600) continue;
      if (sent.has(rule.id + ':' + a.ID) || !matches(rule, a)) continue;
      await send(rule, 'long', a, null);
    }
  }
}

/**
 * Ежедневные сводки. Вызывается раз в минуту: правило с daily_at = '08:00' отправляет
 * сводку за сутки один раз в день — в 08:00 или, если приложение в это время
 * не работало, в течение двух часов после.
 */
export async function runDailyDigests(): Promise<void> {
  const rules = (await activeRules()).filter((r) => r.daily_at);
  if (!rules.length) return;
  const now = nowWall();
  const today = now.slice(0, 10);
  const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const nowMin = minutes(now.slice(11, 16));
  for (const rule of rules) {
    const at = minutes(rule.daily_at as string);
    if (nowMin < at || nowMin - at > 120) continue;
    const [{ c }] = await select<{ c: number }>(
      "SELECT COUNT(*) AS c FROM notify_log WHERE rule_id = ? AND event = 'daily' AND ts >= ?",
      [rule.id, today + ' 00:00:00'],
    );
    if (Number(c) > 0) continue;
    await record(rule, 'daily', null, await digestFor(rule, `${today} ${rule.daily_at}:00`, false));
  }
}

// ---------------------------------------------------------------- правила: проверка ввода

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function readRule(b: any) {
  const errors: Record<string, string> = {};
  const name = str(b?.name);
  if (!name) errors.name = 'Назовите правило, например «Кат. 1 — дежурная смена»';
  else if (name.length > 190) errors.name = 'Не длиннее 190 символов';
  const channel: Channel = 'email';
  if (str(b?.channel) && str(b?.channel) !== 'email') errors.channel = 'Уведомления отправляются только по e-mail';
  const targets = list(str(b?.target).replace(/;/g, ','));
  if (!targets.length) errors.target = 'Укажите адреса e-mail';
  else if (targets.some((t) => !EMAIL_RE.test(t))) errors.target = 'Проверьте адреса: name@motiv.ru, через запятую';
  else {
    const ext = externalAddresses(targets);
    if (ext.length) errors.target = `Только внутренние адреса (${allowedDomains().join(', ')}): ${ext.join(', ')}`;
  }
  const target = targets.join(', ');
  if (target.length > 450) errors.target = 'Слишком много получателей — разделите на несколько правил';

  const pickList = (key: string, allowed: string[]) => {
    const raw: unknown = b?.[key];
    const arr = Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter(Boolean) : list(String(raw || ''));
    const bad = arr.filter((x) => allowed.indexOf(x) < 0);
    if (bad.length) errors[key] = 'Неизвестные значения: ' + bad.join(', ');
    return Array.from(new Set(arr)).join(',');
  };
  const kateg = pickList('kateg', ['1', '2', '3']);
  const napr = pickList('napr', dictValues('napr'));
  const tehc = pickList('tehc', dictValues('tehc'));
  const alarm_types = pickList('alarm_types', dictValues('type'));
  const on_create = b?.on_create === false ? 0 : 1;
  const on_close = b?.on_close === true ? 1 : 0;
  const lhRaw = str(b?.long_hours).replace(',', '.');
  let long_hours: number | null = null;
  if (lhRaw) {
    long_hours = Number(lhRaw);
    if (isNaN(long_hours) || long_hours <= 0 || long_hours > 999) errors.long_hours = 'Часы, от 0,5 до 999';
  }
  const daily_at = str(b?.daily_at) || null;
  if (daily_at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(daily_at)) errors.daily_at = 'Время в формате ЧЧ:ММ, например 08:00';
  if (!on_create && !on_close && !long_hours && !daily_at) errors.events = 'Выберите хотя бы одно событие';
  const is_active = b?.is_active === false ? 0 : 1;
  if (Object.keys(errors).length) throw new HttpError(400, 'Проверьте поля', errors);
  return { name, channel, target, kateg, napr, tehc, alarm_types, on_create, on_close, long_hours, daily_at, is_active };
}

const RULE_COLS = ['name', 'channel', 'target', 'kateg', 'napr', 'tehc', 'alarm_types', 'on_create', 'on_close', 'long_hours', 'daily_at', 'is_active'];

// ---------------------------------------------------------------- маршруты

export const notifyRouter = Router();

notifyRouter.use('/settings', settingsRouter);

/** Уведомления по одной аварии — видны всем ролям в карточке аварии. */
notifyRouter.get('/alarm/:id', requireAuth, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const rows = await select(
    'SELECT id, ts, rule_name, event, channel, target, status, error, sent_at FROM notify_log WHERE alarm_id = ? ORDER BY id DESC LIMIT 100',
    [id],
  );
  res.json({ items: rows });
});

notifyRouter.get('/status', requireAdmin, (_req, res) => {
  res.json(channelStatus());
});

notifyRouter.get('/rules', requireAdmin, async (_req, res) => {
  const rows = await select('SELECT * FROM notify_rules ORDER BY is_active DESC, id');
  const stats = await select(
    "SELECT rule_id, COUNT(*) AS c, SUM(status = 'sent') AS sent, MAX(ts) AS last FROM notify_log GROUP BY rule_id",
  );
  const byRule = new Map(stats.map((s) => [s.rule_id, s]));
  res.json({
    items: rows.map((r) => {
      const s: any = byRule.get(r.id);
      return Object.assign(mapRule(r), { total: s ? Number(s.c) : 0, sent: s ? Number(s.sent) : 0, last: s ? s.last : null });
    }),
    status: channelStatus(),
  });
});

notifyRouter.post('/rules', requireAdmin, async (req, res) => {
  const v: any = readRule(req.body);
  const r = await exec(
    `INSERT INTO notify_rules (${RULE_COLS.join(', ')}, created_at) VALUES (${RULE_COLS.map(() => '?').join(', ')}, ?)`,
    [...RULE_COLS.map((c) => v[c]), nowWall()],
  );
  await logAction(req.user!, 'rule_create', null, { id: r.insertId, name: v.name, channel: v.channel, target: v.target });
  const [row] = await select('SELECT * FROM notify_rules WHERE id = ?', [r.insertId]);
  res.status(201).json({ item: mapRule(row) });
});

notifyRouter.put('/rules/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [before] = await select('SELECT * FROM notify_rules WHERE id = ?', [id]);
  if (!before) throw new HttpError(404, 'Правило не найдено');
  const v: any = readRule(req.body);
  await exec(`UPDATE notify_rules SET ${RULE_COLS.map((c) => c + ' = ?').join(', ')} WHERE id = ?`, [
    ...RULE_COLS.map((c) => v[c]), id,
  ]);
  const changes: Record<string, unknown> = { id, name: before.name };
  for (const c of RULE_COLS) {
    const a = before[c] === null ? '' : String(before[c]);
    const b = v[c] === null ? '' : String(v[c]);
    if (a !== b && !(c === 'long_hours' && Number(a) === Number(b))) changes[c] = [before[c], v[c]];
  }
  await logAction(req.user!, 'rule_update', null, changes);
  const [row] = await select('SELECT * FROM notify_rules WHERE id = ?', [id]);
  res.json({ item: mapRule(row) });
});

notifyRouter.delete('/rules/:id', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [row] = await select('SELECT * FROM notify_rules WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'Правило не найдено');
  await exec('DELETE FROM notify_rules WHERE id = ?', [id]);
  await logAction(req.user!, 'rule_delete', null, { id, name: row.name, channel: row.channel, target: row.target });
  res.json({ ok: true });
});

async function sampleAlarm(): Promise<NotifyAlarm> {
  const [row] = await select('SELECT * FROM alarms ORDER BY ID DESC LIMIT 1');
  const now = nowWall();
  if (row) {
    const open = !row.END_TIME || String(row.END_TIME).indexOf('0000') === 0;
    return Object.assign({}, row, { IS_OPEN: open, END_TIME: open ? null : row.END_TIME, LENGTH_SEC: null }) as NotifyAlarm;
  }
  return {
    ID: 0, PW: null, NAPR: 'ЮЗН', TEHC: 'ЕКБ', KATEG: 1, NETW_TYPE: 'LTE/GSM', SERV_ELEM: 'ЕКБ-0001, ул. Примерная, 1',
    NUMB_RBS: '3', ALARM_TYPE: 'ЭЛ', DESCR: 'Отключение промсети', BEGIN_TIME: now, END_TIME: null, IS_OPEN: true,
    LENGHT: '00:00:00', LENGTH_SEC: 0, PROSTOY: null, COMMON_PROSTOY: null, AKB: null, DGU: null,
  };
}

/**
 * Проверка правила: отправляет то, что правило будет присылать, — пример сообщения
 * об аварии и (если включена) сводку за последние сутки — и сразу сообщает результат.
 */
notifyRouter.post('/rules/:id/test', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [row] = await select('SELECT * FROM notify_rules WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'Правило не найдено');
  rememberOrigin(req);
  const rule = mapRule(row);
  const results: SendResult[] = [];
  if (rule.on_create || rule.on_close || rule.long_hours) {
    results.push(await send(rule, 'test', await sampleAlarm(), req.user!.full_name || req.user!.login));
  }
  if (rule.daily_at) results.push(await record(rule, 'test', null, await digestFor(rule, nowWall(), true)));
  const failed = results.filter((r) => !r.ok);
  res.json({
    ok: !failed.length,
    skipped: failed.length > 0 && failed.every((r) => r.skipped),
    error: failed.length ? failed[0].error : undefined,
    count: results.length,
  });
});

/** Предпросмотр сообщения без отправки; event=daily — ежедневная сводка. */
notifyRouter.get('/preview', requireAdmin, async (req, res) => {
  rememberOrigin(req);
  const ev = str(req.query.event) as NotifyEvent;
  if (ev === 'daily') {
    const now = nowWall();
    res.json(await buildDigest({ kateg: [], napr: [], tehc: [], alarm_types: [] }, now, now, linkBase(), 'Пример', false));
    return;
  }
  const m = buildMessage(EVENT_LABELS[ev] && ev !== 'test' ? (ev as AlarmEvent) : 'create', await sampleAlarm(), { name: 'Пример' }, req.user!.full_name);
  res.json(m);
});

notifyRouter.get('/log', requireAdmin, async (req, res) => {
  const where: string[] = [];
  const params: unknown[] = [];
  const status = str(req.query.status);
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const alarmId = intParam(req.query.alarm_id, 0, 0, 2 ** 31);
  if (alarmId) {
    where.push('alarm_id = ?');
    params.push(alarmId);
  }
  const ruleId = intParam(req.query.rule_id, 0, 0, 2 ** 31);
  if (ruleId) {
    where.push('rule_id = ?');
    params.push(ruleId);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pageSize = intParam(req.query.pageSize, 30, 10, 200);
  const page = intParam(req.query.page, 1, 1, 100000);
  const [{ total }] = await select<{ total: number }>(`SELECT COUNT(*) AS total FROM notify_log ${whereSql}`, params);
  const rows = await select(`SELECT * FROM notify_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, [
    ...params, pageSize, (page - 1) * pageSize,
  ]);
  res.json({ items: rows, total: Number(total), page, pageSize });
});

/** Повторная отправка (например, после настройки SMTP). */
notifyRouter.post('/log/:id/retry', requireAdmin, async (req, res) => {
  const id = intParam(req.params.id, 0, 0, 2 ** 31);
  const [row] = await select('SELECT * FROM notify_log WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'Запись не найдена');
  if (row.status === 'sent') throw new HttpError(409, 'Сообщение уже отправлено');
  const skip = notConfigured(row.channel);
  if (skip) throw new HttpError(409, skip);
  rememberOrigin(req);
  let m: Message;
  const [alarm] = row.alarm_id ? await select('SELECT * FROM alarms WHERE ID = ?', [row.alarm_id]) : [];
  if (alarm && row.event !== 'daily') {
    const open = !alarm.END_TIME || String(alarm.END_TIME) === ZERO_DATETIME;
    const a = Object.assign({}, alarm, { IS_OPEN: open, END_TIME: open ? null : alarm.END_TIME, LENGTH_SEC: null }) as unknown as NotifyAlarm;
    m = buildMessage(row.event, a, { name: row.rule_name || '' }, null);
  } else {
    m = { subject: row.subject, text: row.body, html: `<pre>${esc(row.body)}</pre>` };
  }
  await exec("UPDATE notify_log SET status = 'pending', error = NULL WHERE id = ?", [id]);
  res.json(await deliver(id, row.channel, row.target, m));
});
