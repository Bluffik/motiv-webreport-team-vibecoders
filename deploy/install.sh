#!/bin/sh
# Установка или обновление на сервере (без доступа к Docker Hub).
# Запускать из распакованного комплекта:  sh deploy/install.sh
#
# 1. Загружает образы из images.tar.gz.
# 2. При первом запуске создаёт .env со случайными паролями.
# 3. Поднимает контейнеры и ждёт, пока приложение станет доступно.
# Повторный запуск с новым комплектом — обновление: данные БД сохраняются.
set -eu

cd "$(dirname "$0")/.."

if [ -f images.tar.gz ]; then
  echo "==> Загрузка образов из images.tar.gz"
  gunzip -c images.tar.gz | docker load
fi

rand() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-"$1"
}

set_env() {
  # set_env КЛЮЧ ЗНАЧЕНИЕ — заменить или добавить строку в .env
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

FIRST=0
if [ ! -f .env ]; then
  FIRST=1
  cp .env.example .env
  ADMIN_PW=$(rand 12)
  set_env DB_PASSWORD "$(rand 24)"
  set_env DB_ROOT_PASSWORD "$(rand 24)"
  set_env JWT_SECRET "$(rand 64)"
  set_env ADMIN_PASSWORD "$ADMIN_PW"
  # Демо-стенд: SEED_DEMO=true sh deploy/install.sh — инвентарь, сводка ЦОУ и история за 60 дней.
  [ -n "${SEED_DEMO:-}" ] && set_env SEED_DEMO "$SEED_DEMO"
  [ -n "${APP_URL:-}" ] && set_env APP_URL "$APP_URL"
  chmod 600 .env
  echo "==> Создан .env со случайными паролями"
fi

[ -f VERSION ] && set_env APP_VERSION "$(cat VERSION)"
[ -f DB_IMAGE ] && set_env DB_IMAGE "$(cat DB_IMAGE)"

echo "==> Запуск контейнеров"
sh deploy/compose.sh up -d --no-build

echo "==> Ожидание готовности приложения"
i=0
STATUS=starting
while [ $i -lt 90 ]; do
  STATUS=$(docker inspect -f '{{.State.Health.Status}}' webreport-app 2>/dev/null || echo starting)
  [ "$STATUS" = "healthy" ] && break
  i=$((i + 1))
  sleep 2
done

PORT=$(grep '^APP_PORT=' .env | cut -d= -f2)
PORT=${PORT:-80}
if [ "$STATUS" = "healthy" ]; then
  echo "==> Готово. Веб отчётность: http://<адрес-сервера>$( [ "$PORT" = "80" ] || echo ":$PORT" )"
else
  echo "!! Приложение не ответило за 3 минуты. Журнал: sh deploy/compose.sh logs --tail=100 app" >&2
fi
if [ "$FIRST" = "1" ]; then
  echo "    Вход: $(grep '^ADMIN_LOGIN=' .env | cut -d= -f2) / $ADMIN_PW — смените пароль после входа."
  echo "    Почта для уведомлений: Администрирование → Уведомления → Подключения"
  echo "    (адрес почтового сервера компании, порт, логин, пароль — там же кнопка проверки)."
fi
