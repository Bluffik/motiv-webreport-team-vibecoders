import { FIELD_LABEL, formatBs } from '../../shared/dict';
import { OPEN_END_LABEL, humanDateTime, isOpenEnd } from '../../shared/time';

const nf = new Intl.NumberFormat('ru-RU');

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return nf.format(n);
}

/** Склонение: plural(5, ['авария', 'аварии', 'аварий']). */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** Часы с одним знаком после запятой: «12,5 ч». Для больших сумм простоя. */
export function hours(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const h = sec / 3600;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: h < 10 ? 1 : 0 }).format(h) + ' ч';
}

export const ACTION_LABELS: Record<string, string> = {
  login: 'Вход в систему',
  login_failed: 'Неудачный вход',
  logout: 'Выход',
  password_change: 'Смена пароля',
  alarm_create: 'Авария внесена',
  alarm_update: 'Авария изменена',
  alarm_close: 'Авария закрыта',
  alarm_delete: 'Авария удалена',
  user_create: 'Пользователь создан',
  user_update: 'Пользователь изменён',
  user_delete: 'Пользователь удалён',
  dict_create: 'Справочник: значение добавлено',
  dict_update: 'Справочник: значение изменено',
  dict_delete: 'Справочник: значение удалено',
  station_create: 'БС добавлена в инвентарь',
  station_update: 'БС в инвентаре изменена',
  station_delete: 'БС удалена из инвентаря',
  station_import: 'Инвентарь загружен из CSV',
  rule_create: 'Правило уведомлений создано',
  rule_update: 'Правило уведомлений изменено',
  rule_delete: 'Правило уведомлений удалено',
  alarm_import: 'Загружена сводка Excel',
  token_create: 'Создан ключ API',
  token_revoke: 'Ключ API отозван',
  settings_mail: 'Подключение к почтовому серверу изменено',
  settings_mail_test: 'Проверка почтового сервера',
  alarm_restore: 'Авария восстановлена из корзины',
  alarm_purge: 'Авария удалена из корзины навсегда',
  settings_app_url: 'Адрес приложения для ссылок изменён',
};

const DATETIME_FIELDS = ['BEGIN_TIME', 'END_TIME'];

/** Значение поля аварии для журнала изменений. */
export function auditValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'пусто';
  if (DATETIME_FIELDS.indexOf(field) >= 0) {
    if (field === 'END_TIME' && (v === OPEN_END_LABEL || isOpenEnd(String(v)))) return OPEN_END_LABEL;
    return humanDateTime(String(v));
  }
  if (field === 'NUMB_RBS') return formatBs(v as string);
  if (v === true) return 'да';
  if (v === false) return 'нет';
  return String(v);
}

export function fieldLabel(field: string): string {
  const extra: Record<string, string> = {
    full_name: 'ФИО',
    role: 'Роль',
    is_active: 'Активен',
    password: 'Пароль',
    login: 'Логин',
    value: 'Значение',
    note: 'Расшифровка',
    renamed: 'Переименование',
    alarms_updated: 'Обновлено аварий',
    code: 'Код БС',
    address: 'Адрес',
    napr: 'Направление',
    tehc: 'ТЦ',
    netw_type: 'Тип сети',
    eqip_type: 'Оборудование',
    bs_count: 'Количество БС',
    akb_minutes: 'АКБ, мин',
    has_dgu: 'ДГУ',
    name: 'Название',
    channel: 'Канал',
    target: 'Получатели',
    kateg: 'Категории',
    alarm_types: 'Типы аварий',
    on_create: 'При внесении',
    on_close: 'При закрытии',
    long_hours: 'Эскалация, ч',
    daily_at: 'Сводка в',
    host: 'Сервер',
    port: 'Порт',
    security: 'Шифрование',
    user: 'Логин',
    fromName: 'Имя отправителя',
    fromAddress: 'Адрес отправителя',
    tlsVerify: 'Проверка сертификата',
    allowedDomains: 'Разрешённые домены',
    url: 'Адрес приложения',
  };
  return FIELD_LABEL[field] || extra[field] || field;
}

/** Подписи значений справочника для выпадающих списков: { ЭЛ: 'Электропитание' }. */
export function noteMap(items: Array<{ dict: string; value: string; note: string }>, dict: string): Record<string, string> {
  const m: Record<string, string> = {};
  items.forEach(function (i) {
    if (i.dict === dict && i.note) m[i.value] = i.note;
  });
  return m;
}

/** Все значения справочника (включая скрытые) — для фильтров по старым данным. */
export function allValues(items: Array<{ dict: string; value: string }>, dict: string): string[] {
  return items.filter(function (i) { return i.dict === dict; }).map(function (i) { return i.value; });
}
