import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { migrate, waitForDb } from './db.js';
import { nowWall } from './clock.js';
import { authRouter, authenticate } from './auth.js';
import { alarmsRouter, tickOpenAlarms } from './alarms.js';
import { auditRouter } from './audit.js';
import { dictItems, dictValues, dictsRouter, ensureDicts } from './dicts.js';
import { notifyRouter, runDailyDigests } from './notify.js';
import { reloadSettings } from './settings.js';
import { stationsRouter } from './stations.js';
import { statsRouter } from './stats.js';
import { summaryRouter } from './summary.js';
import { tokensRouter, userFromToken } from './apitokens.js';
import { docsRouter } from './openapi.js';
import { usersRouter } from './users.js';
import { ensureUsers, seedDemo } from './seed.js';
import { HttpError, errorHandler } from './http.js';
import { CATEGORIES, ROLE_HINTS, ROLE_LABELS, WHOLE_NETWORK } from '../../shared/dict.js';

const app = express();
app.disable('x-powered-by');
// TRUST_PROXY: «true», число прокси перед приложением или список адресов/подсетей.
const tp = config.trustProxy.trim();
app.set('trust proxy', /^(true|false)$/i.test(tp) ? /^true$/i.test(tp) : /^\d+$/.test(tp) ? Number(tp) : tp);

// Базовые заголовки безопасности. HSTS — только когда запрос пришёл по HTTPS,
// чтобы работа по HTTP во внутренней сети не ломалась.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
  );
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Сводка Excel приходит в base64 — для её загрузки лимит больше.
app.use('/api/summary/import', express.json({ limit: '40mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Изменяющие запросы к API — только с JSON-телом (защита от отправки форм с чужих сайтов).
app.use('/api', (req, _res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' && !req.is('application/json')) {
    return next(new HttpError(415, 'Ожидается JSON'));
  }
  next();
});
app.use('/api', authenticate);
// Внешние системы: ключ API в заголовке «Authorization: Bearer wr_…».
app.use('/api', (req, _res, next) => {
  if (req.user || !req.headers.authorization) return next();
  userFromToken(req.headers.authorization)
    .then((u) => {
      if (u) req.user = u;
      next();
    })
    .catch(next);
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: nowWall() });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    appName: 'Веб отчётность',
    serverNow: nowWall(),
    timeZone: config.tz,
    demo: config.seedDemo,
    crmUrlTemplate: config.crmUrlTemplate,
    dict: {
      // Активные значения — для выпадающих списков формы.
      directions: dictValues('napr', true),
      techCenters: dictValues('tehc', true),
      categories: CATEGORIES,
      networkTypes: dictValues('netw', true),
      alarmTypes: dictValues('type', true),
      // Все значения со скрытыми и расшифровками — для фильтров и подписей.
      items: dictItems(),
      wholeNetwork: WHOLE_NETWORK,
      roles: ROLE_LABELS,
      roleHints: ROLE_HINTS,
    },
  });
});

app.use('/api/auth', authRouter);
app.use('/api/alarms', alarmsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/users', usersRouter);
app.use('/api/dicts', dictsRouter);
app.use('/api/stations', stationsRouter);
app.use('/api/notify', notifyRouter);
app.use('/api/summary', summaryRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api', docsRouter);
app.use('/api', auditRouter);

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Метод API не найден')));

// Веб-интерфейс (собранный Vite) + SPA-fallback.
const indexHtml = path.join(config.publicDir, 'index.html');
app.use(
  express.static(config.publicDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.indexOf(path.sep + 'assets' + path.sep) >= 0) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }),
);
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (!fs.existsSync(indexHtml)) {
    res.status(503).send('Веб-интерфейс не собран: выполните сборку web (npm run build).');
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexHtml);
});

app.use(errorHandler);

/** HTTPS прямо в приложении — если смонтированы сертификат и ключ (TLS_CERT_FILE, TLS_KEY_FILE). */
function startServers(host: string) {
  const { cert, key } = config.tls;
  const tlsOn = !!cert && !!key && fs.existsSync(cert) && fs.existsSync(key);
  if (cert && key && !tlsOn) console.warn(`[app] HTTPS не включён: не найдены ${cert} или ${key}`);

  if (tlsOn) {
    https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, app).listen(config.tls.port, host, () => {
      console.log(`[app] HTTPS: слушаю ${host}:${config.tls.port}`);
    });
  }
  const redirect = tlsOn && config.tls.redirect;
  const handler = redirect
    ? (req: http.IncomingMessage, res: http.ServerResponse) => {
        // Проверка живости контейнера идёт по HTTP — её не перенаправляем.
        if (req.url === '/api/health') return app(req as any, res as any);
        const hostname = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
        const port = config.tls.publicPort === 443 ? '' : ':' + config.tls.publicPort;
        res.writeHead(301, { Location: `https://${hostname}${port}${req.url || '/'}` });
        res.end();
      }
    : app;
  http.createServer(handler).listen(config.port, host, () => {
    console.log(`[app] HTTP: слушаю ${host}:${config.port}${redirect ? ' (перенаправление на HTTPS)' : ''}; интерфейс: ${config.publicDir}`);
  });
}

async function main() {
  console.log(`[app] Веб отчётность, часовой пояс ${config.tz}, сейчас ${nowWall()}`);
  await waitForDb();
  await migrate();
  await ensureDicts();
  await reloadSettings();
  await ensureUsers();
  await seedDemo();
  const tick = async () => {
    await tickOpenAlarms().catch((e) => console.error('[app] обработка открытых аварий:', e.message));
    await runDailyDigests().catch((e) => console.error('[app] ежедневные сводки:', e.message));
  };
  await tick();
  setInterval(tick, 60_000);
  startServers(process.env.HOST || '0.0.0.0');
}

main().catch((e) => {
  console.error('[app] запуск не удался:', e);
  process.exit(1);
});
