import { Router } from 'express';

// Описание API (OpenAPI 3.0) и страница документации /api/docs — без внешних
// библиотек и CDN: страница собирается из того же описания на сервере.

const alarmExample = {
  ID: 1532,
  PW: 'NTT-63612',
  NAPR: 'ЮЗН',
  TEHC: 'ЕКБ',
  KATEG: 2,
  NETW_TYPE: 'GSM LTE',
  SERV_ELEM: 'GT_VJW — Базовая станция «Солнечный-281»',
  NUMB_RBS: '1',
  EQIP_TYPE: '6630',
  ALARM_TYPE: 'ЭЛ',
  DESCR: 'Аварийное отключение промсети',
  BEGIN_TIME: '2026-11-14 06:10:00',
  END_TIME: null,
  IS_OPEN: true,
  AKB: '01:30:00',
  DGU: null,
  LENGHT: '07:40:22',
  LENGTH_SEC: 27622,
  PROSTOY: null,
  COMMON_PROSTOY: null,
  COMMON_SEC: null,
  ALARM_WHO: '06:25 Савельеву А.В.',
  DESC_NOTICE: 'Выезд не планировался.',
};

const alarmInput = {
  PW: 'NTT-63612',
  NAPR: 'ЮЗН',
  TEHC: 'ЕКБ',
  KATEG: 2,
  NETW_TYPE: 'GSM LTE',
  SERV_ELEM: 'GT_VJW — Базовая станция «Солнечный-281»',
  NUMB_RBS: '1',
  EQIP_TYPE: '6630',
  ALARM_TYPE: 'ЭЛ',
  DESCR: 'Аварийное отключение промсети',
  BEGIN_TIME: '2026-11-14 06:10:00',
  END_TIME: 'НВ',
  AKB: '',
  DGU: '',
  PROSTOY: '',
  ALARM_WHO: 'Савельеву А.В. (при получении сводки)',
  DESC_NOTICE: '',
};

const periodParams = [
  { name: 'from', in: 'query', description: 'Начало периода, ГГГГ-ММ-ДД', schema: { type: 'string', example: '2026-11-01' } },
  { name: 'to', in: 'query', description: 'Конец периода включительно, ГГГГ-ММ-ДД', schema: { type: 'string', example: '2026-11-14' } },
  { name: 'mode', in: 'query', description: '«begin» — начавшиеся в периоде (по умолчанию), «active» — действовавшие', schema: { type: 'string', enum: ['begin', 'active'] } },
];
const filterParams = [
  ...periodParams,
  { name: 'napr', in: 'query', description: 'Направление', schema: { type: 'string', example: 'ЮЗН' } },
  { name: 'tehc', in: 'query', description: 'ТЦ', schema: { type: 'string', example: 'ЕКБ' } },
  { name: 'kateg', in: 'query', description: 'Категория 1, 2 или 3', schema: { type: 'integer' } },
  { name: 'netw', in: 'query', description: 'Тип сети', schema: { type: 'string' } },
  { name: 'type', in: 'query', description: 'Тип аварии', schema: { type: 'string', example: 'ЭЛ' } },
  { name: 'status', in: 'query', description: '«open» — только открытые (НВ), «closed» — закрытые', schema: { type: 'string', enum: ['open', 'closed'] } },
  { name: 'q', in: 'query', description: 'Поиск по PW/NTT, сетевому элементу, оборудованию, описаниям', schema: { type: 'string' } },
];
const idParam = { name: 'id', in: 'path', required: true, description: 'Номер аварии', schema: { type: 'integer' } };

const json = (schemaRef: string, example?: unknown) => ({
  'application/json': Object.assign({ schema: { $ref: '#/components/schemas/' + schemaRef } }, example ? { example } : {}),
});
const errors = {
  '400': { description: 'Ошибка в полях: { error, fields: { ПОЛЕ: текст } }', content: json('Error', { error: 'Проверьте выделенные поля', fields: { BEGIN_TIME: 'Начало не может быть в будущем' } }) },
  '401': { description: 'Нет или неверный ключ', content: json('Error', { error: 'Войдите в систему' }) },
  '403': { description: 'Недостаточно прав (ключ «только чтение»)', content: json('Error', { error: 'Роль «Инженер» — только просмотр' }) },
};

export const OPENAPI = {
  openapi: '3.0.3',
  info: {
    title: 'Веб отчётность — API',
    version: '1.0',
    description:
      'API учёта аварий на базовых станциях. Все даты — время центра (Asia/Yekaterinburg) в формате «ГГГГ-ММ-ДД ЧЧ:ММ:СС». ' +
      'Окончание «НВ» — авария продолжается (в ответах END_TIME = null, IS_OPEN = true). Длительности — «ЧЧ:ММ:СС», часы могут быть больше 24.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Ключ API: Администрирование → API → «Создать ключ». Права «read» — просмотр и выгрузки, «write» — ещё внесение, изменение и закрытие аварий.',
      },
    },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } } } },
      Alarm: {
        type: 'object',
        description: '19 полей по ТЗ, номер записи и вычисляемые поля',
        properties: {
          ID: { type: 'integer' },
          PW: { type: 'string', nullable: true, description: 'Номер PW/NTT' },
          NAPR: { type: 'string', description: 'Направление' },
          TEHC: { type: 'string', nullable: true, description: 'ТЦ (пусто для «Вся сеть»)' },
          KATEG: { type: 'integer', description: 'Категория 1–3' },
          NETW_TYPE: { type: 'string', description: 'Тип сети' },
          SERV_ELEM: { type: 'string', description: 'Сетевой элемент: «код — название»' },
          NUMB_RBS: { type: 'string', description: 'Количество БС: число или «С» (сектор)' },
          EQIP_TYPE: { type: 'string', nullable: true },
          ALARM_TYPE: { type: 'string', description: 'Тип аварии: ЭЛ, RBS, ОПС, ТМ, РРЛ…' },
          DESCR: { type: 'string', nullable: true },
          BEGIN_TIME: { type: 'string' },
          END_TIME: { type: 'string', nullable: true, description: 'null — «НВ»' },
          IS_OPEN: { type: 'boolean' },
          AKB: { type: 'string', nullable: true },
          DGU: { type: 'string', nullable: true },
          LENGHT: { type: 'string', description: 'Длительность (для открытых — на момент запроса)' },
          LENGTH_SEC: { type: 'integer', nullable: true },
          PROSTOY: { type: 'string', nullable: true, description: 'Перерыв связи' },
          COMMON_PROSTOY: { type: 'string', nullable: true, description: 'Общий простой = перерыв × количество БС' },
          COMMON_SEC: { type: 'integer', nullable: true },
          ALARM_WHO: { type: 'string', nullable: true },
          DESC_NOTICE: { type: 'string', nullable: true },
        },
        example: alarmExample,
      },
      AlarmInput: {
        type: 'object',
        required: ['NAPR', 'KATEG', 'NETW_TYPE', 'SERV_ELEM', 'NUMB_RBS', 'ALARM_TYPE', 'BEGIN_TIME'],
        description: 'Значения справочников — из GET /api/meta (dict). END_TIME: дата или «НВ». Длительности: «ЧЧ:ММ:СС». LENGHT и COMMON_PROSTOY считает сервер.',
        example: alarmInput,
      },
      AlarmList: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Alarm' } },
          total: { type: 'integer' },
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
          totals: { type: 'object', description: 'Итоги по всей выборке: count, open, lengthSec, commonSec, bs, sectors, akbSec, dguSec' },
        },
      },
      Station: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          code: { type: 'string', example: 'GT_VJW' },
          address: { type: 'string', example: 'Базовая станция «Солнечный-281»' },
          serv_elem: { type: 'string', example: 'GT_VJW — Базовая станция «Солнечный-281»' },
          napr: { type: 'string' },
          tehc: { type: 'string' },
          netw_type: { type: 'string' },
          eqip_type: { type: 'string', nullable: true },
          bs_count: { type: 'integer' },
          akb_minutes: { type: 'integer', nullable: true, description: 'Автономность АКБ, минут' },
          has_dgu: { type: 'boolean' },
          is_active: { type: 'boolean' },
        },
      },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    '/api/health': {
      get: { tags: ['Служебное'], summary: 'Проверка, что сервис работает', security: [], responses: { '200': { description: 'OK', content: { 'application/json': { example: { ok: true, time: '2026-11-14 14:05:00' } } } } } },
    },
    '/api/meta': {
      get: {
        tags: ['Служебное'],
        summary: 'Справочники и параметры',
        description: 'Допустимые значения направлений, ТЦ, типов сети и аварий (dict), часовой пояс, время сервера.',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/alarms': {
      get: {
        tags: ['Аварии'],
        summary: 'Аварии за период с отбором',
        parameters: [
          ...filterParams,
          { name: 'sort', in: 'query', description: 'id, begin, end, pw, napr, tehc, kateg, type, length, common', schema: { type: 'string' } },
          { name: 'dir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
        ],
        responses: { '200': { description: 'Список и итоги', content: json('AlarmList') }, '401': errors['401'] },
      },
      post: {
        tags: ['Аварии'],
        summary: 'Внести аварию (ключ «write»)',
        description: 'Автоуведомления по правилам уходят так же, как при внесении в интерфейсе.',
        requestBody: { required: true, content: json('AlarmInput', alarmInput) },
        responses: { '201': { description: 'Создана: { item: Alarm }' }, ...errors },
      },
    },
    '/api/alarms/open': {
      get: { tags: ['Аварии'], summary: 'Открытые аварии (НВ) с данными станции из инвентаря', responses: { '200': { description: '{ items: Alarm[], serverNow }' } } },
    },
    '/api/alarms/{id}': {
      get: { tags: ['Аварии'], summary: 'Одна авария', parameters: [idParam], responses: { '200': { description: '{ item: Alarm }' }, '404': { description: 'Не найдена' } } },
      put: {
        tags: ['Аварии'],
        summary: 'Изменить аварию (ключ «write»)',
        parameters: [idParam],
        requestBody: { required: true, content: json('AlarmInput', alarmInput) },
        responses: { '200': { description: '{ item: Alarm }' }, ...errors },
      },
    },
    '/api/alarms/{id}/close': {
      post: {
        tags: ['Аварии'],
        summary: 'Закрыть аварию (ключ «write»)',
        parameters: [idParam],
        requestBody: { required: true, content: { 'application/json': { example: { END_TIME: '2026-11-14 13:55:00' } } } },
        responses: { '200': { description: '{ item: Alarm }' }, ...errors },
      },
    },
    '/api/alarms/{id}/history': {
      get: { tags: ['Аварии'], summary: 'История изменений аварии: кто, когда, что было и что стало', parameters: [idParam], responses: { '200': { description: '{ items }' } } },
    },
    '/api/alarms/export.csv': {
      get: {
        tags: ['Выгрузки'],
        summary: 'CSV за период (UTF-8 с BOM, открывается в Excel)',
        parameters: [...filterParams, { name: 'sep', in: 'query', schema: { type: 'string', enum: ['semicolon', 'comma', 'tab'] } }],
        responses: { '200': { description: 'text/csv' } },
      },
    },
    '/api/summary/export.xlsx': {
      get: {
        tags: ['Выгрузки'],
        summary: 'Excel в формате сводки ЦОУ: лист «Аварии на сети СС»',
        parameters: filterParams,
        responses: { '200': { description: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } },
      },
    },
    '/api/stats': {
      get: {
        tags: ['Статистика'],
        summary: 'Статистика за период: итоги, сравнение с прошлым периодом, разбивки, матрица «ТЦ × тип», повторы, топ',
        parameters: periodParams,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/stations': {
      get: {
        tags: ['Инвентарь'],
        summary: 'Инвентарь БС с числом аварий за 90 дней',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'tehc', in: 'query', schema: { type: 'string' } },
          { name: 'napr', in: 'query', schema: { type: 'string' } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', maximum: 500 } },
        ],
        responses: { '200': { description: '{ items: Station[], total, summary }' } },
      },
    },
    '/api/stations/search': {
      get: { tags: ['Инвентарь'], summary: 'Поиск станции по коду или названию (от 2 символов)', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{ items: Station[] }' } } },
    },
    '/api/stations/resolve': {
      get: {
        tags: ['Инвентарь'],
        summary: 'Станция по строке «Сетевой элемент»',
        description: 'Сопоставление без учёта регистра, вида тире и кавычек; по одному коду — только если он единственный в инвентаре.',
        parameters: [{ name: 'elem', in: 'query', required: true, schema: { type: 'string', example: 'GT_VJW — Базовая станция «Солнечный-281»' } }],
        responses: { '200': { description: '{ item: Station | null }' } },
      },
    },
    '/api/stations/{id}': {
      get: { tags: ['Инвентарь'], summary: 'Станция и её последние аварии', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: '{ item: Station, alarms }' } } },
    },
    '/api/stations/export.csv': {
      get: { tags: ['Выгрузки'], summary: 'Инвентарь в CSV', responses: { '200': { description: 'text/csv' } } },
    },
  },
};

// ---------------------------------------------------------------- страница документации

function esc(s: unknown): string {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function docsHtml(origin: string): string {
  const groups = new Map<string, string[]>();
  for (const [path, ops] of Object.entries(OPENAPI.paths)) {
    for (const [method, op] of Object.entries(ops as Record<string, any>)) {
      const tag = (op.tags && op.tags[0]) || 'Прочее';
      const params = (op.parameters || []) as any[];
      const body = op.requestBody ? op.requestBody.content['application/json'] : null;
      const example = body ? body.example || (body.schema && body.schema.$ref && (OPENAPI.components.schemas as any)[body.schema.$ref.split('/').pop()].example) : null;
      const curl = [
        `curl ${method !== 'get' ? '-X ' + method.toUpperCase() + ' ' : ''}'${origin}${path.replace('{id}', '1532')}'`,
        op.security && op.security.length === 0 ? '' : `  -H 'Authorization: Bearer wr_ваш_ключ'`,
        example ? `  -H 'Content-Type: application/json' -d '${JSON.stringify(example)}'` : '',
      ].filter(Boolean).join(' \\\n');
      const html = `<section class="op">
<h3><span class="m m-${method}">${method.toUpperCase()}</span> <code>${esc(path)}</code></h3>
<p>${esc(op.summary)}${op.description ? '. ' + esc(op.description) : ''}</p>
${params.length ? `<table><thead><tr><th>Параметр</th><th>Где</th><th>Описание</th></tr></thead><tbody>${params
        .map((p) => `<tr><td><code>${esc(p.name)}</code>${p.required ? ' *' : ''}</td><td>${p.in === 'path' ? 'путь' : 'запрос'}</td><td>${esc(p.description || '')}${p.schema && p.schema.enum ? ' (' + p.schema.enum.join(', ') + ')' : ''}</td></tr>`)
        .join('')}</tbody></table>` : ''}
<pre>${esc(curl)}</pre>
<p class="resp">Ответы: ${Object.entries(op.responses || {}).map(([c, r]: [string, any]) => `<b>${c}</b> ${esc(r.description)}`).join('; ')}</p>
</section>`;
      const list = groups.get(tag) || [];
      list.push(html);
      groups.set(tag, list);
    }
  }
  const alarm = OPENAPI.components.schemas.Alarm.properties as Record<string, any>;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>API — Веб отчётность</title>
<style>
body{margin:0;font:14px/1.5 Ubuntu,'Segoe UI',Arial,sans-serif;color:#26282b;background:#f2f2f2}
main{max-width:980px;margin:0 auto;padding:24px 20px 60px;background:#fff;border-top:4px solid #f37021}
h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:32px 0 8px;padding-top:12px;border-top:1px solid #ebeced}
h3{font-size:15px;margin:0 0 4px}code{font-family:Consolas,monospace;font-size:13px;background:#eef0f1;padding:1px 4px;border-radius:3px}
pre{background:#2e3135;color:#f5f5f5;padding:10px 12px;border-radius:4px;overflow:auto;font-size:12.5px;white-space:pre-wrap;word-break:break-all}
table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0}th,td{border:1px solid #dcdddf;padding:4px 8px;text-align:left;vertical-align:top}th{background:#f7f7f8}
.op{padding:14px 0;border-bottom:1px solid #ebeced}.m{display:inline-block;min-width:52px;text-align:center;font-size:12px;font-weight:700;color:#fff;border-radius:3px;padding:1px 6px}
.m-get{background:#1b7350}.m-post{background:#b54e0c}.m-put{background:#44565e}.m-delete{background:#a8161e}.resp{color:#5b5f63;font-size:13px}
.lead{color:#45494e;max-width:75ch}a{color:#b54e0c}
</style></head><body><main>
<h1>API «Веб отчётности»</h1>
<p class="lead">${esc(OPENAPI.info.description)}</p>
<h2>Доступ</h2>
<p class="lead">Ключ создаёт администратор: <b>Администрирование → API → «Создать ключ»</b>. Ключ показывается один раз; передавайте его в заголовке
<code>Authorization: Bearer wr_…</code>. Права «read» — просмотр, отчёты, выгрузки; «write» — ещё внесение, изменение и закрытие аварий.
Через API нельзя управлять пользователями, справочниками и настройками. Изменяющие запросы — только с <code>Content-Type: application/json</code>.
Все действия по ключу пишутся в журнал действий под именем «API: название ключа».</p>
<p>Машиночитаемое описание: <a href="/api/openapi.json">/api/openapi.json</a> (OpenAPI 3.0 — открывается в Postman, Swagger Editor, Insomnia).</p>
<h2>Поля аварии</h2>
<table><thead><tr><th>Поле</th><th>Описание</th></tr></thead><tbody>${Object.entries(alarm)
    .map(([k, v]) => `<tr><td><code>${k}</code></td><td>${esc(v.description || '')}</td></tr>`)
    .join('')}</tbody></table>
${Array.from(groups.entries()).map(([tag, ops]) => `<h2>${esc(tag)}</h2>${ops.join('')}`).join('')}
</main></body></html>`;
}

export const docsRouter = Router();

docsRouter.get('/openapi.json', (_req, res) => {
  res.json(OPENAPI);
});

docsRouter.get('/docs', (req, res) => {
  const origin = `${req.protocol}://${req.get('host') || 'localhost'}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(docsHtml(origin));
});
