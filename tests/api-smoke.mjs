// Сквозная проверка API на демо-базе: node tests/api-smoke.mjs [http://127.0.0.1:8080]
// Нужны пользователи admin/admin и duty/duty (SEED_DEMO=true, ADMIN_PASSWORD=admin).
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
let passed = 0;
let failed = 0;
const ok = (c, m, x) => {
  if (c) passed++;
  else {
    failed++;
    console.log('FAIL:', m, x !== undefined ? JSON.stringify(x).slice(0, 400) : '');
  }
};

async function call(method, url, data, headers) {
  const res = await fetch(BASE + url, {
    method,
    headers: Object.assign({}, headers, data !== undefined ? { 'Content-Type': 'application/json' } : {}),
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON */
  }
  return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
}

async function session(login, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  ok(r.status === 200, 'login ' + login);
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return (method, url, data) => call(method, url, data, { Cookie: cookie });
}

const health = await call('GET', '/api/health');
ok(health.status === 200 && health.json.ok, 'health');
const admin = await session('admin', 'admin');
const duty = await session('duty', 'duty');
const eng = await session('engineer', 'engineer');

const meta = (await duty('GET', '/api/meta')).json;
ok(meta && meta.dict.techCenters.length >= 18, 'meta dictionaries', meta && meta.dict);
const today = meta.serverNow.slice(0, 10);
const monthAgo = new Date(Date.parse(today) - 30 * 86400000).toISOString().slice(0, 10);

// Аварии
let r = await duty('GET', `/api/alarms?from=${monthAgo}&to=${today}&pageSize=5`);
ok(r.status === 200 && r.json.total > 100, 'demo alarms for 30 days', r.json && r.json.total);
r = await duty('GET', '/api/alarms/open');
ok(r.status === 200 && r.json.items.length > 0 && r.json.items.some((a) => a.STATION), 'open alarms with inventory');
r = await duty('GET', `/api/stats?from=${monthAgo}&to=${today}`);
ok(r.status === 200 && r.json.totals.count > 0, 'stats');

const alarm = {
  NAPR: 'ЮЗН', TEHC: 'ЕКБ', KATEG: 3, NETW_TYPE: 'GSM LTE', SERV_ELEM: 'CI_T01 — Базовая станция «Проверка CI»', NUMB_RBS: 'С',
  ALARM_TYPE: 'RBS', DESCR: 'Блокировка сектора', BEGIN_TIME: meta.serverNow.slice(0, 16) + ':00', END_TIME: 'НВ', PROSTOY: '',
};
r = await eng('POST', '/api/alarms', alarm);
ok(r.status === 403, 'engineer cannot create');
r = await duty('POST', '/api/alarms', Object.assign({}, alarm, { BEGIN_TIME: '2099-01-01 00:00:00' }));
ok(r.status === 400 && r.json.fields.BEGIN_TIME, 'future date rejected');
r = await duty('POST', '/api/alarms', alarm);
ok(r.status === 201 && r.json.item.IS_OPEN && r.json.item.NUMB_RBS === 'С', 'duty creates alarm', r.json);
const id = r.json.item.ID;
r = await duty('PUT', `/api/alarms/${id}`, Object.assign({}, alarm, { END_TIME: meta.serverNow.slice(0, 16) + ':00', PROSTOY: '00:30:00' }));
ok(r.status === 200 && r.json.item.COMMON_PROSTOY === '00:30:00', 'sector counts as 1 BS', r.json);
r = await duty('GET', `/api/alarms/${id}/history`);
ok(r.status === 200 && r.json.items.length >= 2, 'history');

// Выгрузки
r = await eng('GET', `/api/alarms/export.csv?from=${today}&to=${today}`);
ok(r.status === 200 && /text\/csv/.test(r.type) && /^﻿?№;/.test(r.text), 'csv export');
r = await eng('GET', `/api/summary/export.xlsx?from=${today}&to=${today}`);
ok(r.status === 200 && /spreadsheetml/.test(r.type), 'xlsx export');

// Инвентарь
r = await eng('GET', '/api/stations?pageSize=10&sort=alarms');
ok(r.status === 200 && r.json.total > 100, 'stations');
const st = r.json.items[0];
r = await eng('GET', '/api/stations/resolve?elem=' + encodeURIComponent(st.serv_elem));
ok(r.json.item && r.json.item.id === st.id, 'resolve station');

// Ключи API
r = await admin('POST', '/api/tokens', { name: 'CI', scope: 'read' });
ok(r.status === 201, 'token created');
const auth = { Authorization: 'Bearer ' + r.json.token };
const tokenId = r.json.item.id;
r = await call('GET', '/api/alarms/open', undefined, auth);
ok(r.status === 200, 'token reads');
r = await call('POST', '/api/alarms', alarm, auth);
ok(r.status === 403, 'read token cannot write');
await admin('DELETE', '/api/tokens/' + tokenId);
r = await call('GET', '/api/alarms/open', undefined, auth);
ok(r.status === 401, 'revoked token');

// Документация, настройки, права
r = await call('GET', '/api/openapi.json');
ok(r.status === 200 && r.json.openapi, 'openapi');
r = await duty('GET', '/api/notify/settings');
ok(r.status === 403, 'duty cannot read settings');
r = await admin('GET', '/api/notify/settings');
ok(r.status === 200 && r.json.mail, 'admin reads settings');

// Корзина: удаление → восстановление с прежним номером → удаление навсегда
r = await duty('DELETE', `/api/alarms/${id}`);
ok(r.status === 403, 'duty cannot delete');
r = await admin('DELETE', `/api/alarms/${id}`);
ok(r.status === 200, 'admin deletes to trash');
r = await duty('GET', `/api/alarms/${id}`);
ok(r.status === 404, 'deleted alarm hidden');
r = await admin('GET', '/api/alarms/trash/list?q=CI_T01');
ok(r.status === 200 && r.json.items.some((x) => x.ID === id), 'alarm in trash', r.json);
r = await admin('POST', `/api/alarms/trash/${id}/restore`, {});
ok(r.status === 200 && r.json.id === id, 'restored with same id', r.json);
r = await duty('GET', `/api/alarms/${id}`);
ok(r.status === 200, 'restored alarm visible');
await admin('DELETE', `/api/alarms/${id}`);
r = await admin('DELETE', `/api/alarms/trash/${id}`);
ok(r.status === 200, 'purged from trash');

// Уведомления — только e-mail, только внутренние адреса
r = await admin('POST', '/api/notify/rules', { name: 'CI', channel: 'telegram', target: '-1001234567890', on_create: true });
ok(r.status === 400 && r.json.fields.channel, 'telegram channel rejected', r.json);
await admin('PUT', '/api/notify/settings/mail', { host: 'mail.example.local', port: '587', security: 'starttls', fromName: 'CI', fromAddress: 'webreport@corp.local', tlsVerify: true });
r = await admin('POST', '/api/notify/rules', { name: 'CI', target: 'someone@gmail.com', on_create: true });
ok(r.status === 400 && /внутренние/.test(r.json.fields.target || ''), 'external recipient rejected', r.json);
r = await admin('POST', '/api/notify/rules', { name: 'CI', target: 'cou@corp.local, ekb@tc.corp.local', on_create: true });
ok(r.status === 201, 'internal recipients accepted', r.json);
if (r.json && r.json.item) await admin('DELETE', '/api/notify/rules/' + r.json.item.id);
await admin('PUT', '/api/notify/settings/mail', { host: '', port: '587', security: 'starttls', fromName: '', fromAddress: '', tlsVerify: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
