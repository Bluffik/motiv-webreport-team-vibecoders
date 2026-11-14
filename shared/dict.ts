// Справочники и общие константы. Модуль общий для сервера и веб-интерфейса.
//
// Значения справочников хранятся в БД (таблица dict_items) и редактируются
// администратором. Списки ниже — начальное наполнение: по ТЗ (раздел 5)
// и по обезличенной сводке ЦОУ (значения, которые встречаются в реальной работе,
// и расшифровки с листа «Справочная информация»).

export const DIRECTIONS = ['ХМЯН', 'СВН', 'ЮЗН', 'Вся сеть'];

export const TECH_CENTERS = [
  'НБР', 'АСБ', 'ИРБ', 'КРТ', 'НТГ', 'НТР', 'НУРЛ', 'НВРТ', 'НУРГ',
  'ОКТ', 'СЛХ', 'СОВ', 'СРГ', 'ХМН', 'ЕКБ', 'КМУ', 'КРГ', 'НСР', 'ШДР',
];

export const CATEGORIES = [1, 2, 3];

/** «GSM LTE» — так тип сети записан в сводке; «LTE/GSM» — по ТЗ. */
export const NETWORK_TYPES = ['GSM LTE', 'GSM', 'LTE', 'LTE/GSM'];

export const ALARM_TYPES = ['ЭЛ', 'RBS', 'ОПС', 'ТМ', 'РРЛ', 'РРС', 'ДГУ', 'ИБП', 'ВОЛС', 'ССС', 'МСПД', 'ПР', 'АВР', 'Аренда'];

/** Расшифровки кодов типов: подтверждённые куратором и с листа «Справочная информация» сводки. */
export const ALARM_TYPE_NOTES: Record<string, string> = {
  ЭЛ: 'Электропитание',
  RBS: 'Неисправность оборудования БС',
  ТМ: 'Телеметрия',
  РРС: 'Радиорелейная сеть связи',
  РРЛ: 'Радиорелейная линия (привязка БС)',
  ОПС: 'Охранно-пожарная сигнализация',
  ДГУ: 'Дизель-генераторная установка',
  ИБП: 'Источник бесперебойного питания',
  ВОЛС: 'Волоконно-оптическая линия связи',
  ССС: 'Спутниковая сеть связи',
  МСПД: 'Мультисервисная сеть передачи данных',
  ПР: 'Плановые работы',
};

/** Полные названия направлений и ТЦ — с листа «Справочная информация» сводки. */
export const DIRECTION_NOTES: Record<string, string> = {
  СВН: 'Северо-восточное направление',
  ЮЗН: 'Юго-западное направление',
  ХМЯН: 'Регион ХМАО-ЯНАО',
  'Вся сеть': 'Авария затрагивает всю сеть — ТЦ не указывается',
};

export const TECH_CENTER_NOTES: Record<string, string> = {
  АСБ: 'Асбестовский центр',
  ЕКБ: 'Екатеринбургский центр',
  ИРБ: 'Ирбитский центр',
  КМУ: 'Каменск-Уральский центр',
  КРТ: 'Краснотурьинский центр',
  КРГ: 'Курганский центр',
  НВРТ: 'Нижневартовское отделение',
  НСР: 'Нижнесергинский центр',
  НТГ: 'Нижнетагильский центр',
  НТР: 'Нижнетуринский центр',
  НУРЛ: 'Новоуральское отделение',
  НУРГ: 'Новоуренгойское отделение',
  НБР: 'Ноябрьский центр',
  СЛХ: 'Салехардское отделение',
  СОВ: 'Советское отделение',
  СРГ: 'Сургутский центр',
  ХМН: 'Ханты-Мансийское отделение',
  ОКТ: 'Октябрьское отделение',
};

/** Начальные расшифровки для справочника. */
export function defaultNote(dict: string, value: string): string {
  if (dict === 'type') return ALARM_TYPE_NOTES[value] || '';
  if (dict === 'napr') return DIRECTION_NOTES[value] || '';
  if (dict === 'tehc') return TECH_CENTER_NOTES[value] || '';
  return '';
}

/** Справочники, которые редактирует администратор. Ключ — поле аварии. */
export type DictKey = 'napr' | 'tehc' | 'netw' | 'type';

export const DICTS: Array<{ key: DictKey; field: string; label: string; plural: string; defaults: string[] }> = [
  { key: 'napr', field: 'NAPR', label: 'Направление', plural: 'Направления', defaults: DIRECTIONS },
  { key: 'tehc', field: 'TEHC', label: 'ТЦ', plural: 'Технические центры', defaults: TECH_CENTERS },
  { key: 'netw', field: 'NETW_TYPE', label: 'Тип сети', plural: 'Типы сети', defaults: NETWORK_TYPES },
  { key: 'type', field: 'ALARM_TYPE', label: 'Тип аварии', plural: 'Типы аварий', defaults: ALARM_TYPES },
];

export interface DictItem {
  id: number;
  dict: DictKey;
  value: string;
  note: string;
  sort: number;
  is_active: boolean;
  is_system: boolean;
}

/** Направление, для которого ТЦ не указывается (ответ куратора, вопрос 8). */
export const WHOLE_NETWORK = 'Вся сеть';

/** Тип аварии «электропитание»: для него считается прогноз разряда АКБ. */
export const POWER_TYPE = 'ЭЛ';

/** «С» (сектор) в поле «Количество БС». Поле текстовое (ответ куратора, вопрос 1). */
export const SECTOR_LABEL = 'С';
export const MAX_BS = 10000;
export const TEXT_MAX = 450;

export type Role = 'admin' | 'duty' | 'engineer';

export const ROLES: Role[] = ['admin', 'duty', 'engineer'];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Администратор',
  duty: 'Дежурный',
  engineer: 'Инженер',
};

export const ROLE_HINTS: Record<Role, string> = {
  admin: 'Полный доступ: аварии, удаление, инвентарь, справочники, пользователи, уведомления, журнал',
  duty: 'Вносит, редактирует и закрывает аварии',
  engineer: 'Только просмотр, отчёты и выгрузка CSV',
};

export function canEdit(role: Role | undefined | null): boolean {
  return role === 'admin' || role === 'duty';
}

export function isAdmin(role: Role | undefined | null): boolean {
  return role === 'admin';
}

/** Порядок и подписи полей таблицы аварий — как в ТЗ (пункты 1–19). */
export const FIELDS: Array<{ key: string; label: string; short: string }> = [
  { key: 'PW', label: 'Номер PW/NTT', short: 'PW/NTT' },
  { key: 'NAPR', label: 'Направление', short: 'Напр.' },
  { key: 'TEHC', label: 'ТЦ', short: 'ТЦ' },
  { key: 'KATEG', label: 'Категория', short: 'Кат.' },
  { key: 'NETW_TYPE', label: 'Тип сети', short: 'Сеть' },
  { key: 'SERV_ELEM', label: 'Сетевой элемент, услуга', short: 'Сетевой элемент' },
  { key: 'NUMB_RBS', label: 'Количество БС', short: 'БС' },
  { key: 'EQIP_TYPE', label: 'Тип оборудования', short: 'Оборудование' },
  { key: 'ALARM_TYPE', label: 'Тип', short: 'Тип' },
  { key: 'DESCR', label: 'Описание', short: 'Описание' },
  { key: 'BEGIN_TIME', label: 'Начало', short: 'Начало' },
  { key: 'END_TIME', label: 'Окончание', short: 'Окончание' },
  { key: 'AKB', label: 'АКБ', short: 'АКБ' },
  { key: 'DGU', label: 'ГУ', short: 'ГУ' },
  { key: 'LENGHT', label: 'Длительность аварии', short: 'Длительность' },
  { key: 'PROSTOY', label: 'Время перерыва связи', short: 'Перерыв' },
  { key: 'COMMON_PROSTOY', label: 'Общее время простоя БС', short: 'Простой БС' },
  { key: 'ALARM_WHO', label: 'Уведомление об аварии (кому)', short: 'Уведомление' },
  { key: 'DESC_NOTICE', label: 'Подробное описание', short: 'Подробно' },
];

export const FIELD_LABEL: Record<string, string> = FIELDS.reduce(function (acc, f) {
  acc[f.key] = f.label;
  return acc;
}, {} as Record<string, string>);

/** Приводит ввод «Количества БС» к хранимому виду: «12» или «С». null — если ввод некорректен. */
export function normalizeBs(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim().toUpperCase();
  if (v === 'С' || v === 'C' || v === '0') return SECTOR_LABEL; // 0 — старое хранение сектора
  if (/^\d+$/.test(v) && +v >= 1 && +v <= MAX_BS) return String(+v);
  return null;
}

export function isSector(v: string | number | null | undefined): boolean {
  return normalizeBs(v) === SECTOR_LABEL;
}

/** Количество БС для сумм: сектор не считается целой БС (0), число — как есть. */
export function bsCount(v: string | number | null | undefined): number {
  const n = normalizeBs(v);
  return n && n !== SECTOR_LABEL ? +n : 0;
}

/** Отображение «Количества БС». */
export function formatBs(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  return normalizeBs(v) || String(v);
}

/** Если в поле PW/NTT ссылка — вернуть её; если номер и задан шаблон CRM — собрать ссылку. */
export function crmLink(value: string | null | undefined, template: string): string | null {
  const v = (value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (template && template.indexOf('{id}') >= 0) return template.split('{id}').join(encodeURIComponent(v));
  return null;
}

/**
 * Код объекта в начале «Сетевого элемента». Формат сводки ЦОУ:
 * «VJ_K29 — Базовая станция «Кедровый-110»» → «VJ_K29»; старый формат «ЕКБ-0412, ул. Ленина» → «ЕКБ-0412».
 */
export const STATION_CODE_RE = /^\s*([A-Za-zА-Яа-яЁё0-9]{1,8}(?:[_\-./][A-Za-zА-Яа-яЁё0-9]{1,8}){0,3})(?=\s*(?:[—–,]|\s-\s|$))/;

export function stationCodeOf(servElem: string | null | undefined): string | null {
  const m = STATION_CODE_RE.exec(servElem || '');
  return m ? m[1].toUpperCase() : null;
}

/** «Сетевой элемент» из кода и названия объекта — как в сводке: «VJ_K29 — Базовая станция «Кедровый-110»». */
export function formatElem(code: string, name: string | null | undefined): string {
  return name ? code + ' — ' + name : code;
}

/**
 * Нормализованная строка сетевого элемента для сопоставления аварии со станцией:
 * без учёта регистра, вида тире и кавычек, лишних пробелов. Код в обезличенной
 * сводке не уникален, поэтому станцию опознаём по всей строке «код — название».
 */
export function elemKey(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»“”„"]/g, '"')
    .replace(/\s*[—–]\s*|\s+-\s+/g, ' — ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,]+$/, '');
}
