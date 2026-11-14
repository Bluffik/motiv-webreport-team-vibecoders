import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on|да)$/i.test(v.trim());
}

function firstExisting(candidates: string[]): string {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const cwd = process.cwd();

export const config = {
  port: Number(process.env.PORT || 8080),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'webreport',
    password: process.env.DB_PASSWORD || 'webreport',
    database: process.env.DB_NAME || 'webreport',
  },
  jwtSecret: process.env.JWT_SECRET || '',
  /** Часовой пояс центра: в нём хранятся и вводятся все даты. */
  tz: process.env.APP_TZ || 'Asia/Yekaterinburg',
  adminLogin: process.env.ADMIN_LOGIN || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  /** Демо-режим: тестовые пользователи и аварии за последние 60 дней (только для пустой БД). */
  seedDemo: bool(process.env.SEED_DEMO, false),
  /** Шаблон ссылки на заявку в CRM, например https://crm.local/ticket/{id}. */
  crmUrlTemplate: process.env.CRM_URL_TEMPLATE || '',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  /** true — cookie только по HTTPS. При встроенном HTTPS или X-Forwarded-Proto=https ставится само. */
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  /** Адрес приложения для ссылок в уведомлениях, например https://report.motiv.local */
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 25),
    /** true — сразу TLS (порт 465); false — STARTTLS, если сервер его предлагает. */
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'Веб отчётность <webreport@localhost>',
    /** false — принимать самоподписанный сертификат почтового сервера. */
    tlsVerify: bool(process.env.SMTP_TLS_VERIFY, true),
  },
  tls: {
    cert: process.env.TLS_CERT_FILE || '',
    key: process.env.TLS_KEY_FILE || '',
    port: Number(process.env.HTTPS_PORT || 8443),
    /** Публичный порт HTTPS (для перенаправления с HTTP), по умолчанию 443. */
    publicPort: Number(process.env.HTTPS_PUBLIC_PORT || 443),
    /** Перенаправлять HTTP на HTTPS, когда HTTPS включён. */
    redirect: bool(process.env.HTTP_REDIRECT, true),
  },
  /** Доверять X-Forwarded-* от балансировщика (TLS терминируется на нём). */
  trustProxy: process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
  publicDir: process.env.PUBLIC_DIR || firstExisting([path.join(cwd, 'public'), path.join(cwd, '..', 'web', 'dist')]),
  /** Обезличенная сводка ЦОУ для демо-данных (лист «Аварии на сети СС» в JSON). */
  demoFile:
    process.env.DEMO_FILE ||
    firstExisting([path.join(cwd, 'db', 'demo', 'summary-cc.json'), path.join(cwd, '..', 'db', 'demo', 'summary-cc.json')]),
  schemaFile:
    process.env.SCHEMA_FILE ||
    firstExisting([path.join(cwd, 'db', '01-schema.sql'), path.join(cwd, '..', 'db', 'init', '01-schema.sql')]),
};

if (!config.jwtSecret) {
  config.jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET не задан — сгенерирован временный ключ, сессии сбросятся при перезапуске.');
}
