import crypto from 'node:crypto';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from './config.js';
import { computeCommonSeconds, formatDuration, sqlTimeToSeconds } from '../../shared/time.js';
import { elemKey, formatElem } from '../../shared/dict.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  charset: 'UTF8MB4_UNICODE_CI',
  // Даты и время приходят строками как есть: '0000-00-00 00:00:00' (НВ) не превращается в Invalid Date.
  dateStrings: true,
  connectionLimit: 10,
  waitForConnections: true,
});

// Строгий режим, но без NO_ZERO_DATE: нулевая дата — штатное значение «НВ» по ТЗ.
pool.on('connection', (conn) => {
  conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'");
});

export type Row = RowDataPacket & Record<string, any>;

export async function select<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

export async function exec(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await pool.query<ResultSetHeader>(sql, params);
  return res;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ждём, пока БД станет доступна (контейнер MariaDB стартует дольше приложения). */
export async function waitForDb(attempts = 60): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const rows = await select<{ v: string }>('SELECT VERSION() AS v');
      console.log(`[db] подключено к ${config.db.host}:${config.db.port}, версия ${rows[0].v}`);
      return;
    } catch (e: any) {
      console.log(`[db] ожидание БД (${i}/${attempts}): ${e.code || e.message}`);
      await sleep(2000);
    }
  }
  throw new Error('БД недоступна');
}

/** Выполняет db/init/01-schema.sql (все CREATE TABLE IF NOT EXISTS — безопасно при каждом старте). */
export async function migrate(): Promise<void> {
  const sql = fs.readFileSync(config.schemaFile, 'utf8');
  const cleaned = sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const statements = cleaned
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const st of statements) await exec(st);
  console.log(`[db] схема проверена (${statements.length} инструкций из ${config.schemaFile})`);
  await upgradeColumns();
}

/** Ключ станции: SHA-1 нормализованной строки «код — название». */
export function stationKey(code: string, address: string | null | undefined): string {
  return crypto.createHash('sha1').update(elemKey(formatElem(code, address))).digest('hex');
}

async function columnType(table: string, column: string): Promise<string | null> {
  const rows = await select<{ t: string }>(
    'SELECT DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column],
  );
  return rows[0] ? String(rows[0].t).toLowerCase() : null;
}

/**
 * Приведение баз, созданных по первой версии схемы (строго по ТЗ), к уточнениям куратора:
 * NUMB_RBS INT → VARCHAR («С» вместо 0), COMMON_PROSTOY TIME → VARCHAR (без предела 838:59:59).
 */
async function upgradeColumns(): Promise<void> {
  if ((await columnType('alarms', 'NUMB_RBS')) === 'int') {
    await exec('ALTER TABLE alarms MODIFY NUMB_RBS VARCHAR(16) NULL');
    await exec("UPDATE alarms SET NUMB_RBS = 'С' WHERE NUMB_RBS = '0'");
    console.log('[db] NUMB_RBS переведён в текст, сектор хранится как «С»');
  }
  if ((await columnType('alarms', 'COMMON_PROSTOY')) === 'time') {
    await exec('ALTER TABLE alarms MODIFY COMMON_PROSTOY VARCHAR(450) NULL');
    const rows = await select('SELECT ID, PROSTOY, NUMB_RBS FROM alarms WHERE PROSTOY IS NOT NULL');
    for (const r of rows) {
      const common = computeCommonSeconds(sqlTimeToSeconds(r.PROSTOY), r.NUMB_RBS);
      await exec('UPDATE alarms SET COMMON_PROSTOY = ? WHERE ID = ?', [common === null ? null : formatDuration(common), r.ID]);
    }
    console.log(`[db] COMMON_PROSTOY переведён в текст, пересчитано ${rows.length} строк`);
  }
  if ((await columnType('stations', 'elem_key')) === null) {
    await exec('ALTER TABLE stations ADD COLUMN elem_key CHAR(40) NULL AFTER address');
    const rows = await select('SELECT id, code, address FROM stations');
    for (const r of rows) await exec('UPDATE stations SET elem_key = ? WHERE id = ?', [stationKey(r.code, r.address), r.id]);
    const idx = await select<{ n: string }>(
      "SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stations'",
    );
    const names = idx.map((i) => i.n);
    if (names.indexOf('uq_station_code') >= 0) await exec('ALTER TABLE stations DROP INDEX uq_station_code');
    await exec('ALTER TABLE stations MODIFY elem_key CHAR(40) NOT NULL, ADD UNIQUE KEY uq_station_elem (elem_key)');
    if (names.indexOf('idx_station_code') < 0) await exec('ALTER TABLE stations ADD KEY idx_station_code (code)');
    console.log(`[db] stations: станция опознаётся по паре «код — название» (${rows.length} строк)`);
  }
  if ((await columnType('alarms_deleted', 'deleted_at')) === null) {
    await exec('ALTER TABLE alarms_deleted MODIFY ID INT UNSIGNED NOT NULL, ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN deleted_by VARCHAR(190) NULL');
    console.log('[db] корзина удалённых аварий готова');
  }
  // Telegram больше не поддерживается: такие правила выключаем, настройки бота удаляем.
  const tg = await exec("UPDATE notify_rules SET is_active = 0 WHERE channel <> 'email' AND is_active = 1");
  if (tg.affectedRows) console.log(`[db] выключено правил Telegram: ${tg.affectedRows}`);
  await exec("DELETE FROM app_settings WHERE k = 'telegram'");
  if ((await columnType('notify_rules', 'daily_at')) === null) {
    await exec('ALTER TABLE notify_rules ADD COLUMN daily_at VARCHAR(5) NULL AFTER long_hours');
    console.log('[db] notify_rules: добавлен столбец daily_at (ежедневная сводка)');
  }
}
