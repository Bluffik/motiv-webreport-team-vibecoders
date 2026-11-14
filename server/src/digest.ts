import { select } from './db.js';
import { rowToApi, type ApiAlarm } from './alarms.js';
import { dictItems, dictValues } from './dicts.js';
import { ZERO_DATETIME, formatDateTime, formatDuration, humanDateTime, humanDuration, parseDateTime } from '../../shared/time.js';

// Ежедневная сводка: что случилось за прошедшие сутки по авариям, подходящим
// под условия правила уведомлений. Уходит в заданное время, например в 08:00
// к началу смены (смена 08:00–08:00).

export interface DigestFilter {
  kateg: string[];
  napr: string[];
  tehc: string[];
  alarm_types: string[];
}

export interface DigestMessage {
  subject: string;
  text: string;
  html: string;
  count: number;
}

const OPEN_COND = `(END_TIME IS NULL OR END_TIME = '${ZERO_DATETIME}')`;

function esc(s: unknown): string {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function alarmsWord(n: number): string {
  return n + ' ' + plural(n, 'авария', 'аварии', 'аварий');
}

function filterSql(f: DigestFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.kateg.length) {
    where.push('KATEG IN (?)');
    params.push(f.kateg.map(Number));
  }
  if (f.napr.length) {
    where.push('NAPR IN (?)');
    params.push(f.napr);
  }
  if (f.tehc.length) {
    where.push('TEHC IN (?)');
    params.push(f.tehc);
  }
  if (f.alarm_types.length) {
    where.push('ALARM_TYPE IN (?)');
    params.push(f.alarm_types);
  }
  return { sql: where.length ? ' AND ' + where.join(' AND ') : '', params };
}

/** «по всей сети» или «ТЦ ЕКБ, кат. 1» — для заголовка. */
export function scopeLabel(f: DigestFilter): string {
  const parts: string[] = [];
  if (f.tehc.length) parts.push('ТЦ ' + f.tehc.join(', '));
  if (f.napr.length) parts.push(f.napr.join(', '));
  if (f.kateg.length) parts.push('кат. ' + f.kateg.join(', '));
  if (f.alarm_types.length) parts.push('тип ' + f.alarm_types.join(', '));
  return parts.length ? parts.join('; ') : 'вся сеть';
}

function typeNote(code: string): string {
  const it = dictItems('type').find((i) => i.value === code);
  return it && it.note ? it.note : '';
}

function where(a: ApiAlarm): string {
  return a.TEHC ? 'ТЦ ' + a.TEHC : a.NAPR || '';
}

/**
 * Сводка за сутки, закончившиеся в `end` ('YYYY-MM-DD HH:MM:SS', время центра).
 * `base` — адрес приложения для ссылок; `test` — пометка проверочного сообщения.
 */
export async function buildDigest(f: DigestFilter, end: string, now: string, base: string, ruleName: string | null, test: boolean): Promise<DigestMessage> {
  const endMs = parseDateTime(end) as number;
  const start = formatDateTime(endMs - 86400000);
  const prevStart = formatDateTime(endMs - 2 * 86400000);
  const flt = filterSql(f);

  // Смена 08:00–08:00: в сводку попадают все аварии, действовавшие в эти сутки, —
  // и начавшиеся раньше (открыта 13-го, закрыта 18-го — есть в сводке за 14-е).
  const active = `BEGIN_TIME < ? AND (${OPEN_COND} OR END_TIME >= ?)`;
  const dayRows = await select(`SELECT * FROM alarms WHERE ${active}${flt.sql} ORDER BY BEGIN_TIME`, [end, start, ...flt.params]);
  const openRows = await select(`SELECT * FROM alarms WHERE ${OPEN_COND}${flt.sql} ORDER BY BEGIN_TIME LIMIT 200`, flt.params);
  const [{ c: prevCount }] = await select<{ c: number }>(
    `SELECT COUNT(*) AS c FROM alarms WHERE ${active}${flt.sql}`,
    [start, prevStart, ...flt.params],
  );
  const freshCount = dayRows.filter((r) => String(r.BEGIN_TIME) >= start).length;

  const day = dayRows.map((r) => rowToApi(r, now));
  const open = openRows.map((r) => rowToApi(r, now));
  const prev = Number(prevCount);
  const count = day.length;
  const cat1 = day.filter((a) => a.KATEG === 1).length;
  const closed = day.filter((a) => !a.IS_OPEN && a.LENGTH_SEC !== null);
  const avgSec = closed.length ? Math.round(closed.reduce((s, a) => s + (a.LENGTH_SEC || 0), 0) / closed.length) : 0;
  const commonSec = day.reduce((s, a) => s + (a.COMMON_SEC || 0), 0);

  // По типам — в порядке справочника, только встретившиеся.
  const typeOrder = dictValues('type');
  const byType = new Map<string, number>();
  for (const a of day) byType.set(a.ALARM_TYPE || '—', (byType.get(a.ALARM_TYPE || '—') || 0) + 1);
  const types = Array.from(byType.entries()).sort((x, y) => {
    const ix = typeOrder.indexOf(x[0]);
    const iy = typeOrder.indexOf(y[0]);
    return y[1] - x[1] || (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  });

  const byTc = new Map<string, number>();
  for (const a of day) {
    const k = a.TEHC || a.NAPR || '—';
    byTc.set(k, (byTc.get(k) || 0) + 1);
  }
  const tcs = Array.from(byTc.entries()).sort((x, y) => y[1] - x[1]).slice(0, 6);

  // Открытые и так перечислены выше — здесь самые долгие из закрытых за сутки.
  const longest = closed.slice().sort((x, y) => (y.LENGTH_SEC || 0) - (x.LENGTH_SEC || 0)).slice(0, 3);

  const period = `${humanDateTime(start)} — ${humanDateTime(end)}`;
  const scope = scopeLabel(f);
  const delta = count - prev;
  const deltaText = prev || count ? (delta === 0 ? 'столько же, сколько сутками ранее' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} к предыдущим суткам (${prev})`) : '';
  const subject = `${test ? 'Проверка. ' : ''}Сводка за смену (${scope}): ${alarmsWord(count)}, кат. 1 — ${cat1}, открыто сейчас ${open.length}`;
  const statsLink = base ? `${base}/#/stats` : '';
  const footer = ruleName ? `Правило уведомления: «${ruleName}». Веб отчётность.` : 'Веб отчётность.';
  const lead = test
    ? 'Это проверочное сообщение: так будет выглядеть ежедневная сводка по этому правилу.'
    : count
      ? `За смену действовало ${alarmsWord(count)}, из них новых — ${freshCount}${deltaText ? '; ' + deltaText : ''}.`
      : 'За смену аварий не было.';

  // ---------------- текст (e-mail без HTML и журнал)
  const lines: string[] = [`Сводка за смену ${period}`, `Объём: ${scope}`, '', lead, ''];
  lines.push(`Аварий за смену: ${count}, новых ${freshCount}${prev || count ? ` (сутками ранее ${prev})` : ''}`);
  lines.push(`Категория 1: ${cat1}`);
  lines.push(`Открыто сейчас: ${open.length}`);
  lines.push(`Общий простой БС: ${formatDuration(commonSec) || '00:00:00'}`);
  if (closed.length) lines.push(`Средняя длительность закрытых: ${humanDuration(avgSec)}`);
  if (types.length) {
    lines.push('', 'По типам:');
    for (const [t, n] of types) lines.push(`  ${t}${typeNote(t) ? ' (' + typeNote(t) + ')' : ''}: ${n}`);
  }
  if (tcs.length > 1) {
    lines.push('', 'По ТЦ:');
    for (const [t, n] of tcs) lines.push(`  ${t}: ${n}`);
  }
  if (open.length) {
    lines.push('', 'Открытые аварии:');
    for (const a of open.slice(0, 15)) {
      lines.push(`  №${a.ID}, ${humanDuration(a.LENGTH_SEC)}: кат. ${a.KATEG}, ${a.ALARM_TYPE}, ${where(a)} — ${a.SERV_ELEM || '—'}`);
    }
    if (open.length > 15) lines.push(`  …и ещё ${open.length - 15}`);
  }
  if (longest.length && longest[0].LENGTH_SEC) {
    lines.push('', 'Самые долгие из закрытых:');
    for (const a of longest) lines.push(`  №${a.ID}, ${humanDuration(a.LENGTH_SEC)}: ${a.ALARM_TYPE}, ${where(a)} — ${a.SERV_ELEM || '—'}`);
  }
  lines.push('');
  if (statsLink) lines.push(`Статистика: ${statsLink}`);
  lines.push(footer);
  const text = lines.join('\n');

  // ---------------- HTML-письмо
  const td = 'padding:6px 10px 6px 0;border-bottom:1px solid #ebeced;vertical-align:top';
  const maxType = types.length ? types[0][1] : 1;
  const kpi = (label: string, value: string, sub: string) =>
    `<td style="padding:12px 14px;background:#f7f7f8;border-left:3px solid #f37021;width:25%;vertical-align:top">
<div style="font-size:12px;color:#707478">${esc(label)}</div>
<div style="font-size:22px;font-weight:bold;margin-top:2px">${esc(value)}</div>
${sub ? `<div style="font-size:12px;color:#707478;margin-top:2px">${esc(sub)}</div>` : ''}</td>`;
  const section = (title: string, body: string) =>
    `<tr><td style="padding:14px 24px 4px"><div style="font-size:15px;font-weight:bold;margin-bottom:6px">${esc(title)}</div>${body}</td></tr>`;

  const typeTable = types.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${types
        .map(
          ([t, n]) => `<tr><td style="${td};white-space:nowrap"><b>${esc(t)}</b>${typeNote(t) ? ` <span style="color:#707478">${esc(typeNote(t))}</span>` : ''}</td>
<td style="${td};width:45%"><div style="background:#f37021;height:10px;width:${Math.max(4, Math.round((n / maxType) * 100))}%"></div></td>
<td style="${td};text-align:right;white-space:nowrap">${n}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const tcTable =
    tcs.length > 1
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${tcs
          .map(([t, n]) => `<tr><td style="${td}">${esc(t)}</td><td style="${td};text-align:right">${n}</td></tr>`)
          .join('')}</table>`
      : '';
  const alarmRow = (a: ApiAlarm, extra: string) =>
    `<tr><td style="${td};white-space:nowrap">${base ? `<a href="${esc(base)}/#/alarm/${a.ID}" style="color:#d65a0f">№${a.ID}</a>` : '№' + a.ID}</td>
<td style="${td};white-space:nowrap">${esc(humanDuration(a.LENGTH_SEC))}${extra}</td>
<td style="${td}">кат. ${esc(a.KATEG)}, ${esc(a.ALARM_TYPE)}, ${esc(where(a))}<br><span style="color:#707478">${esc(a.SERV_ELEM || '—')}</span></td></tr>`;
  const openTable = open.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${open
        .slice(0, 15)
        .map((a) => alarmRow(a, ''))
        .join('')}</table>${open.length > 15 ? `<div style="font-size:13px;color:#707478;margin-top:6px">…и ещё ${open.length - 15}</div>` : ''}`
    : '';
  const longTable =
    longest.length && longest[0].LENGTH_SEC
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${longest
          .map((a) => alarmRow(a, ''))
          .join('')}</table>`
      : '';

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f2f2f2;font-family:Arial,Helvetica,sans-serif;color:#2e3135">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#ffffff;border-top:4px solid #f37021">
<tr><td style="padding:20px 24px 8px"><div style="font-size:13px;color:#d65a0f;font-weight:bold">${test ? 'Проверка: ежедневная сводка' : 'Ежедневная сводка'}</div>
<div style="font-size:18px;font-weight:bold;margin-top:4px">Сутки ${esc(period)}</div>
<div style="font-size:14px;margin-top:4px;color:#5b5f63">Объём: ${esc(scope)}. ${esc(lead)}</div></td></tr>
<tr><td style="padding:10px 24px"><table role="presentation" cellpadding="0" cellspacing="6" style="width:100%;margin:0 -6px"><tr>
${kpi('Аварий за смену', String(count), `новых ${freshCount}, сутками ранее ${prev}`)}
${kpi('Категория 1', String(cat1), '')}
${kpi('Открыто сейчас', String(open.length), '')}
${kpi('Общий простой БС', formatDuration(commonSec) || '00:00:00', closed.length ? `средняя длит. ${humanDuration(avgSec)}` : '')}
</tr></table></td></tr>
${typeTable ? section('По типам аварий', typeTable) : ''}
${tcTable ? section('По техническим центрам', tcTable) : ''}
${openTable ? section('Открытые аварии', openTable) : ''}
${longTable ? section('Самые долгие из закрытых', longTable) : ''}
${statsLink ? `<tr><td style="padding:16px 24px 20px"><a href="${esc(statsLink)}" style="display:inline-block;background:#f37021;color:#ffffff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:4px">Открыть статистику</a></td></tr>` : ''}
<tr><td style="padding:12px 24px;font-size:12px;color:#707478;border-top:1px solid #ebeced">${esc(footer)}</td></tr>
</table></body></html>`;

  return { subject: subject.slice(0, 440), text, html, count };
}
