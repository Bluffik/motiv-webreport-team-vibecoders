# API

У «Веб отчётности» есть REST API. Через него внешние системы читают аварии и отчёты, а при нужных правах — вносят и закрывают аварии. Подходит для мониторинга (Zabbix), CRM и скриптов ЦОУ.

- Полное описание с примерами — на самом сервере: `https://‹домен›/api/docs`.
- Машиночитаемое описание (OpenAPI 3.0) — `https://‹домен›/api/openapi.json`. Открывается в Postman, Insomnia и Swagger Editor.

## Доступ

1. Администратор: «Администрирование → API → Создать ключ». Нужно указать название системы, права и срок действия.
2. Ключ показывается один раз. В базе хранится только его хэш SHA-256.
3. Ключ передаётся в каждом запросе:

```
Authorization: Bearer wr_…
```

| Права | Что можно |
|---|---|
| Только чтение | аварии, табло открытых, статистика, инвентарь, выгрузки CSV и Excel |
| Чтение и запись | то же и внесение, изменение, закрытие аварий |

Управлять пользователями, справочниками и настройками через API нельзя. Все действия по ключу пишутся в журнал под именем «API: название ключа». Отозванный ключ перестаёт работать сразу.

## Соглашения

- Даты — время центра (`Asia/Yekaterinburg`) в формате `ГГГГ-ММ-ДД ЧЧ:ММ:СС`.
- Открытая авария: при записи `END_TIME: "НВ"`, в ответе `END_TIME: null, IS_OPEN: true`.
- Длительности — `ЧЧ:ММ:СС`, часы могут быть больше 24. `LENGHT` и `COMMON_PROSTOY` считает сервер.
- `NUMB_RBS` — число или `С` (сектор; в общем простое считается как одна БС).
- Значения справочников (направления, ТЦ, типы) — из `GET /api/meta`, поле `dict`.
- Запросы, которые что-то меняют, — только с `Content-Type: application/json`.
- Ошибки: `{ "error": "текст", "fields": { "ПОЛЕ": "что не так" } }`. Коды: 400 — поля, 401 — нет ключа, 403 — не хватает прав, 404 — нет записи.

## Примеры

```bash
KEY='wr_…'; URL='https://‹домен›'

# Открытые аварии
curl -H "Authorization: Bearer $KEY" "$URL/api/alarms/open"

# Аварии по электропитанию в ТЦ ЕКБ за неделю
curl -H "Authorization: Bearer $KEY" "$URL/api/alarms?from=2026-11-08&to=2026-11-14&tehc=ЕКБ&type=ЭЛ&pageSize=100"

# Отчёт в формате сводки ЦОУ
curl -H "Authorization: Bearer $KEY" -o svodka.xlsx "$URL/api/summary/export.xlsx?from=2026-11-01&to=2026-11-14"

# Внести аварию (ключ «чтение и запись»)
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$URL/api/alarms" -d '{
  "NAPR": "ЮЗН", "TEHC": "ЕКБ", "KATEG": 2, "NETW_TYPE": "GSM LTE",
  "SERV_ELEM": "GT_VJW — Базовая станция «Солнечный-281»", "NUMB_RBS": "1",
  "ALARM_TYPE": "ЭЛ", "DESCR": "Аварийное отключение промсети",
  "BEGIN_TIME": "2026-11-14 06:10:00", "END_TIME": "НВ"
}'

# Закрыть
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  "$URL/api/alarms/1532/close" -d '{"END_TIME": "2026-11-14 13:55:00"}'
```

## Методы

| Метод | Что делает | Права |
|---|---|---|
| `GET /api/health` | сервис работает | без ключа |
| `GET /api/meta` | справочники, часовой пояс, время сервера | чтение |
| `GET /api/alarms` | аварии за период: `from`, `to`, `mode`, `napr`, `tehc`, `kateg`, `netw`, `type`, `status`, `q`, `sort`, `dir`, `page`, `pageSize` | чтение |
| `GET /api/alarms/open` | открытые аварии с данными станции из инвентаря | чтение |
| `GET /api/alarms/{id}` | одна авария | чтение |
| `GET /api/alarms/{id}/history` | история изменений | чтение |
| `POST /api/alarms` | внести аварию | запись |
| `PUT /api/alarms/{id}` | изменить | запись |
| `POST /api/alarms/{id}/close` | закрыть | запись |
| `GET /api/alarms/export.csv` | CSV за период, те же фильтры, `sep=semicolon\|comma\|tab` | чтение |
| `GET /api/summary/export.xlsx` | Excel в формате сводки ЦОУ | чтение |
| `GET /api/stats` | статистика за период | чтение |
| `GET /api/stations` | инвентарь, `q`, `tehc`, `napr`, `page`, `pageSize` | чтение |
| `GET /api/stations/search?q=` | поиск объекта | чтение |
| `GET /api/stations/resolve?elem=` | объект по строке «Сетевой элемент» | чтение |
| `GET /api/stations/{id}` | объект и его аварии | чтение |
| `GET /api/stations/export.csv` | инвентарь в CSV | чтение |

Интерфейс приложения работает через тот же API, но с cookie сессии. Методы администрирования (`/api/users`, `/api/dicts`, `/api/notify`, `/api/tokens`, `/api/summary/import`) доступны только администратору после входа в интерфейс.
