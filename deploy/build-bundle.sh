#!/bin/sh
# Сборка комплекта поставки для сервера без доступа к Docker Hub.
# Запускать на машине с Docker и интернетом (рабочий ноутбук, CI):
#
#   sh deploy/build-bundle.sh [версия]
#
# Результат: dist-bundle/webreport-<версия>.tar.gz — образы приложения и БД,
# docker-compose*.yml, схема БД, .env.example и скрипты установки.
# На сервере: tar xzf webreport-<версия>.tar.gz && cd webreport-<версия> && sh deploy/install.sh
set -eu

cd "$(dirname "$0")/.."
VERSION=${1:-$(date +%Y%m%d-%H%M)}
DB_IMAGE=${DB_IMAGE:-mariadb:11.4}
OUT_ROOT=dist-bundle
OUT="$OUT_ROOT/webreport-$VERSION"

echo "==> Сборка образа приложения webreport-app:$VERSION"
docker build -t "webreport-app:$VERSION" -t webreport-app:latest .

echo "==> Загрузка образа БД $DB_IMAGE"
docker pull "$DB_IMAGE"

rm -rf "$OUT"
mkdir -p "$OUT"
echo "==> Сохранение образов (несколько минут)"
docker save "webreport-app:$VERSION" "$DB_IMAGE" | gzip > "$OUT/images.tar.gz"

cp docker-compose.yml docker-compose.https.yml docker-compose.dbport.yml .env.example "$OUT/"
cp -R db deploy "$OUT/"
printf '%s\n' "$VERSION" > "$OUT/VERSION"
printf '%s\n' "$DB_IMAGE" > "$OUT/DB_IMAGE"

tar -C "$OUT_ROOT" -czf "$OUT_ROOT/webreport-$VERSION.tar.gz" "webreport-$VERSION"
rm -rf "$OUT"

FILE="$OUT_ROOT/webreport-$VERSION.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$FILE" > "$FILE.sha256"; fi
echo "==> Готово: $FILE ($(du -h "$FILE" | cut -f1))"
echo "    Перенесите на сервер и выполните:"
echo "    tar xzf webreport-$VERSION.tar.gz && cd webreport-$VERSION && sh deploy/install.sh"
