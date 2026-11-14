#!/bin/sh
# Резервная копия БД:   sh deploy/backup.sh            → backups/webreport-ГГГГ-ММ-ДД-ЧЧММ.sql.gz
# Восстановление:       sh deploy/backup.sh restore backups/<файл>.sql.gz
# Для ежедневной копии добавьте в cron:  0 3 * * * cd /opt/webreport && sh deploy/backup.sh
set -eu

cd "$(dirname "$0")/.."
DUMP='if command -v mariadb-dump >/dev/null 2>&1; then D=mariadb-dump; else D=mysqldump; fi; exec $D -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines "$MYSQL_DATABASE"'
CLIENT='if command -v mariadb >/dev/null 2>&1; then C=mariadb; else C=mysql; fi; exec $C -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'

if [ "${1:-}" = "restore" ]; then
  FILE=${2:?Укажите файл: sh deploy/backup.sh restore backups/<файл>.sql.gz}
  echo "Восстановить БД из $FILE? Текущие данные будут заменены. Введите yes:"
  read -r ANSWER
  [ "$ANSWER" = "yes" ] || { echo "Отменено"; exit 1; }
  gunzip -c "$FILE" | docker exec -i webreport-db sh -c "$CLIENT"
  docker restart webreport-app >/dev/null
  echo "==> Восстановлено, приложение перезапущено"
  exit 0
fi

mkdir -p backups
FILE="backups/webreport-$(date +%F-%H%M).sql.gz"
docker exec webreport-db sh -c "$DUMP" | gzip > "$FILE"
# Храним 30 последних копий.
ls -1t backups/webreport-*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
echo "==> $FILE ($(du -h "$FILE" | cut -f1))"
