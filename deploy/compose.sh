#!/bin/sh
# Обёртка над docker-compose: сама выбирает v1/v2 и подключает
#  - HTTPS, если в ./certs лежат server.crt и server.key;
#  - порт БД наружу, если в .env задано DB_EXPOSE=1.
# Примеры:
#   sh deploy/compose.sh ps
#   sh deploy/compose.sh logs -f app
#   sh deploy/compose.sh up -d --no-build
set -eu

cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "Не найден docker compose (v2) или docker-compose (v1)" >&2
  exit 1
fi

FILES="-f docker-compose.yml"
if [ -f certs/server.crt ] && [ -f certs/server.key ]; then
  FILES="$FILES -f docker-compose.https.yml"
fi
if grep -q '^DB_EXPOSE=1' .env 2>/dev/null; then
  FILES="$FILES -f docker-compose.dbport.yml"
fi

# shellcheck disable=SC2086
exec $DC $FILES "$@"
