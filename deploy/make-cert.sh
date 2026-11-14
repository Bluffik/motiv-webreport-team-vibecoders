#!/bin/sh
# Самоподписанный сертификат для HTTPS (если нет корпоративного):
#
#   sh deploy/make-cert.sh report.motiv.local      # по имени
#   sh deploy/make-cert.sh 10.0.0.15               # по IP
#
# Кладёт certs/server.crt и certs/server.key. Корпоративный сертификат — просто положите
# эти два файла сами. После этого: sh deploy/compose.sh up -d --no-build (HTTPS включится сам).
set -eu

cd "$(dirname "$0")/.."
HOST=${1:?Укажите имя или IP сервера: sh deploy/make-cert.sh <имя-или-IP>}

case "$HOST" in
  *[!0-9.]*) SAN="DNS:$HOST" ;;
  *) SAN="IP:$HOST" ;;
esac

mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=$HOST/O=Webreport" -addext "subjectAltName=$SAN"
# Приложение в контейнере работает не от root — ключ должен быть читаемым.
chmod 644 certs/server.crt certs/server.key
echo "==> Сертификат: certs/server.crt (действует 825 дней, $SAN)"
