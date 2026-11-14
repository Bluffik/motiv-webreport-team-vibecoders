-- «Веб отчётность» — схема БД.
-- Работает на MariaDB 10.1 и новее (по умолчанию — 11.4 LTS). Скрипт идемпотентен:
-- его выполняет контейнер БД при первой инициализации и приложение при каждом старте.
-- Приведение старых баз к новым типам столбцов делает приложение (server/src/db.ts).

SET NAMES utf8mb4;

-- Таблица аварий. Поля — по ТЗ (раздел 5) с уточнениями куратора:
--  * NUMB_RBS — текст: число БС или «С» (сектор), ответ на вопрос 1;
--  * COMMON_PROSTOY — текст «ЧЧЧ:ММ:СС» без ограничения 838:59:59 типа TIME, вопрос 3.
-- ID добавлен как первичный ключ: без него невозможно редактировать строку.
-- Окончание «НВ» (настоящее время) хранится как '0000-00-00 00:00:00'.
CREATE TABLE IF NOT EXISTS alarms (
  ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
  PW VARCHAR(450),
  NAPR VARCHAR(450),
  TEHC VARCHAR(450),
  KATEG TINYINT,
  NETW_TYPE VARCHAR(450),
  SERV_ELEM VARCHAR(450),
  NUMB_RBS VARCHAR(16),
  EQIP_TYPE VARCHAR(450),
  ALARM_TYPE VARCHAR(450),
  DESCR VARCHAR(450),
  BEGIN_TIME DATETIME,
  END_TIME DATETIME,
  AKB TIME,
  DGU TIME,
  LENGHT VARCHAR(450),
  PROSTOY TIME,
  COMMON_PROSTOY VARCHAR(450),
  ALARM_WHO VARCHAR(450),
  DESC_NOTICE VARCHAR(450),
  PRIMARY KEY (ID),
  KEY idx_alarms_begin (BEGIN_TIME),
  KEY idx_alarms_end (END_TIME)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci ROW_FORMAT=DYNAMIC;

-- Пользователи и роли: admin — администратор, duty — дежурный, engineer — инженер.
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  login VARCHAR(64) NOT NULL,
  full_name VARCHAR(190) NOT NULL DEFAULT '',
  role VARCHAR(16) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  last_login_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_login (login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Журнал действий: кто, когда и что изменил (прозрачность отчётности).
CREATE TABLE IF NOT EXISTS audit_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts DATETIME NOT NULL,
  user_id INT UNSIGNED NULL,
  user_login VARCHAR(64) NULL,
  user_name VARCHAR(190) NULL,
  action VARCHAR(32) NOT NULL,
  alarm_id INT UNSIGNED NULL,
  details TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_ts (ts),
  KEY idx_audit_alarm (alarm_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Справочники выпадающих списков (направления, ТЦ, типы сети, типы аварий).
-- Редактирует администратор; скрытые значения остаются в старых записях и фильтрах.
CREATE TABLE IF NOT EXISTS dict_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  dict VARCHAR(16) NOT NULL,
  value VARCHAR(64) NOT NULL,
  note VARCHAR(190) NOT NULL DEFAULT '',
  sort INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dict_value (dict, value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Инвентарь базовых станций: из него форма подставляет адрес, ТЦ, направление,
-- тип сети и оборудование. Автономность АКБ нужна для прогноза разряда.
CREATE TABLE IF NOT EXISTS stations (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(32) NOT NULL,
  address VARCHAR(400) NOT NULL,
  -- Ключ «код — название» (SHA-1 нормализованной строки): в обезличенной сводке
  -- один код встречается у разных объектов, поэтому уникальна только пара.
  elem_key CHAR(40) NOT NULL,
  napr VARCHAR(64) NULL,
  tehc VARCHAR(64) NULL,
  netw_type VARCHAR(64) NULL,
  eqip_type VARCHAR(190) NULL,
  bs_count INT NOT NULL DEFAULT 1,
  akb_minutes INT NULL,
  has_dgu TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(450) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_station_elem (elem_key),
  KEY idx_station_code (code),
  KEY idx_station_tehc (tehc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Правила автоуведомлений: кому (e-mail или Telegram) и о каких авариях сообщать.
-- Пустой фильтр — «любое значение». Списки хранятся через запятую.
CREATE TABLE IF NOT EXISTS notify_rules (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(190) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  target VARCHAR(450) NOT NULL,
  kateg VARCHAR(16) NOT NULL DEFAULT '',
  napr VARCHAR(450) NOT NULL DEFAULT '',
  tehc VARCHAR(450) NOT NULL DEFAULT '',
  alarm_types VARCHAR(450) NOT NULL DEFAULT '',
  on_create TINYINT(1) NOT NULL DEFAULT 1,
  on_close TINYINT(1) NOT NULL DEFAULT 0,
  long_hours DECIMAL(5,1) NULL,
  daily_at VARCHAR(5) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Журнал отправленных уведомлений (и не отправленных — с причиной).
CREATE TABLE IF NOT EXISTS notify_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts DATETIME NOT NULL,
  rule_id INT UNSIGNED NULL,
  rule_name VARCHAR(190) NULL,
  alarm_id INT UNSIGNED NULL,
  event VARCHAR(16) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  target VARCHAR(450) NOT NULL,
  subject VARCHAR(450) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(16) NOT NULL,
  error VARCHAR(450) NULL,
  sent_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_notify_ts (ts),
  KEY idx_notify_alarm (alarm_id),
  KEY idx_notify_rule_alarm (rule_id, alarm_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Настройки, которые администратор меняет в интерфейсе: подключение к почтовому
-- серверу компании и Telegram-боту. Пароль и токен хранятся зашифрованными.
CREATE TABLE IF NOT EXISTS app_settings (
  k VARCHAR(64) NOT NULL,
  v TEXT NOT NULL,
  updated_at DATETIME NOT NULL,
  updated_by VARCHAR(190) NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ключи доступа к API для внешних систем. Хранится только SHA-256 ключа.
CREATE TABLE IF NOT EXISTS api_tokens (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  scope VARCHAR(8) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  prefix VARCHAR(16) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  created_by VARCHAR(190) NULL,
  last_used_at DATETIME NULL,
  expires_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Корзина: удалённые аварии. Удаление переносит запись сюда (с тем же ID),
-- администратор может её восстановить. Столбцы deleted_at и deleted_by
-- добавляются при запуске (server/src/db.ts).
CREATE TABLE IF NOT EXISTS alarms_deleted LIKE alarms;
