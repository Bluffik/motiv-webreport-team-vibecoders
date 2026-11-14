#!/bin/sh
# Установка «Веб отчётности» на сервер по SSH — по данным из deploy/servers.env.
#
#   sh deploy/remote-deploy.sh <шаг>
#
# Шаги (all — все по порядку):
#   check      доступ по SSH, ОС, Docker, место на диске, DNS домена
#   docker     поставить Docker и docker-compose из пакетов ОС, если их нет
#   bundle     комплект с образами: BUILD_ON=app — собрать на сервере (нужен Docker Hub),
#              BUILD_ON=local — взять готовый dist-bundle/webreport-$VERSION.tar.gz
#   app        установить приложение, выпустить сертификат Let's Encrypt (если задан APP_DOMAIN)
#   configure  подключить почтовый сервер и адрес для ссылок (через API)
#   status     проверить, что всё отвечает
#
# Нужны локально: ssh, scp, tar, curl, node (для JSON). Запуск из корня проекта.
set -eu

cd "$(dirname "$0")/.."
CONF=deploy/servers.env
SECRETS=deploy/.secrets
[ -f "$CONF" ] || { echo "Нет $CONF — скопируйте deploy/servers.env.example и заполните" >&2; exit 1; }
# shellcheck disable=SC1090
. "./$CONF"
[ -f "$SECRETS" ] && . "./$SECRETS"
SSH_KEY=$(eval echo "${SSH_KEY:-~/.ssh/webreport_deploy}")
VERSION=${VERSION:-1.0.0}
APP_DIR=${APP_DIR:-/opt/webreport}
BUILD_ON=${BUILD_ON:-local}

say() { printf '\n==> %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }
need() { [ -n "$(eval echo "\${$1:-}")" ] || die "Заполните $1 в $CONF"; }

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30"
on_app() { ssh $SSH_OPTS -p "${APP_SSH_PORT:-22}" "${APP_SSH_USER:-root}@$APP_HOST" "$@"; }
to_app() { scp $SSH_OPTS -P "${APP_SSH_PORT:-22}" "$1" "${APP_SSH_USER:-root}@$APP_HOST:$2"; }
sudo_app() { [ "${APP_SSH_USER:-root}" = root ] && echo "" || echo "sudo"; }

save_secret() {
  # save_secret КЛЮЧ ЗНАЧЕНИЕ — в deploy/.secrets (в git не попадает)
  touch "$SECRETS"
  grep -v "^$1=" "$SECRETS" > "$SECRETS.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$SECRETS.tmp"
  mv "$SECRETS.tmp" "$SECRETS"
  chmod 600 "$SECRETS" 2>/dev/null || true
}

step_check() {
  need APP_HOST
  say "Сервер $APP_HOST"
  on_app 'uname -sr; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; docker --version 2>/dev/null || echo "Docker не установлен"; (docker compose version || docker-compose --version) 2>/dev/null || echo "Compose не установлен"; df -h / | tail -1'
  on_app 'curl -s -o /dev/null -m 10 -w "Docker Hub: HTTP %{http_code}\n" https://registry-1.docker.io/v2/ || echo "Docker Hub недоступен — BUILD_ON=local"'
  if [ -n "${APP_DOMAIN:-}" ]; then
    ip=$(nslookup "$APP_DOMAIN" 2>/dev/null | awk '/^Address/ {a=$2} END {print a}')
    echo "DNS $APP_DOMAIN → ${ip:-не найден}"
  fi
}

step_docker() {
  need APP_HOST
  S=$(sudo_app)
  say "Docker из пакетов ОС (docker.io и docker-compose)"
  on_app "command -v docker >/dev/null || ($S apt-get update && $S DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose && $S systemctl enable --now docker)"
  on_app 'docker --version && (docker compose version 2>/dev/null || docker-compose --version)'
}

step_bundle() {
  need APP_HOST
  if [ "$BUILD_ON" = app ]; then
    say "Сборка комплекта на сервере"
    tar --exclude=node_modules --exclude=dist --exclude=dist-bundle --exclude=release --exclude=certs --exclude=backups \
        --exclude='.env' --exclude='.env.local' --exclude='deploy/servers.env' --exclude='deploy/.secrets' \
        --exclude='*.xlsx' --exclude='*.pdf' --exclude='.git' \
        -czf /tmp/webreport-src.tgz Dockerfile .dockerignore docker-compose.yml docker-compose.https.yml docker-compose.dbport.yml \
        .env.example db deploy server shared web
    on_app "mkdir -p /tmp/webreport-build && rm -rf /tmp/webreport-build/*"
    to_app /tmp/webreport-src.tgz /tmp/webreport-build/src.tgz
    rm -f /tmp/webreport-src.tgz
    on_app "cd /tmp/webreport-build && tar xzf src.tgz && sh deploy/build-bundle.sh $VERSION && mv dist-bundle/webreport-$VERSION.tar.gz /tmp/"
  else
    f="dist-bundle/webreport-$VERSION.tar.gz"
    [ -f "$f" ] || die "Нет $f — скачайте комплект из GitHub Releases или соберите: sh deploy/build-bundle.sh $VERSION"
    say "Переношу $f на сервер"
    to_app "$f" "/tmp/webreport-$VERSION.tar.gz"
  fi
}

step_app() {
  need APP_HOST
  S=$(sudo_app)
  say "Распаковываю комплект в $APP_DIR"
  on_app "$S mkdir -p $APP_DIR && $S chown \$(id -u) $APP_DIR && tar xzf /tmp/webreport-$VERSION.tar.gz -C $APP_DIR --strip-components=1"
  if [ -n "${APP_DOMAIN:-}" ]; then
    say "Сертификат Let's Encrypt для $APP_DOMAIN"
    email=${LE_EMAIL:+-m $LE_EMAIL}
    [ -z "$email" ] && email=--register-unsafely-without-email
    on_app "command -v certbot >/dev/null || ($S apt-get update && $S DEBIAN_FRONTEND=noninteractive apt-get install -y certbot)
      docker stop webreport-app >/dev/null 2>&1 || true
      $S certbot certonly --standalone -n --agree-tos $email -d $APP_DOMAIN \
        --pre-hook 'docker stop webreport-app || true' --post-hook 'docker start webreport-app || true' \
        --deploy-hook 'cp /etc/letsencrypt/live/$APP_DOMAIN/fullchain.pem $APP_DIR/certs/server.crt && cp /etc/letsencrypt/live/$APP_DOMAIN/privkey.pem $APP_DIR/certs/server.key && chmod 644 $APP_DIR/certs/server.*'
      mkdir -p $APP_DIR/certs
      $S cp /etc/letsencrypt/live/$APP_DOMAIN/fullchain.pem $APP_DIR/certs/server.crt
      $S cp /etc/letsencrypt/live/$APP_DOMAIN/privkey.pem $APP_DIR/certs/server.key
      $S chmod 644 $APP_DIR/certs/server.*"
    url="https://$APP_DOMAIN"
  else
    say "Домена нет — самоподписанный сертификат на IP $APP_HOST"
    on_app "cd $APP_DIR && [ -f certs/server.crt ] || sh deploy/make-cert.sh $APP_HOST"
    url="https://$APP_HOST"
  fi
  say "Установка"
  on_app "cd $APP_DIR && SEED_DEMO=${SEED_DEMO:-false} APP_URL=$url sh deploy/install.sh"
  say "Резервная копия БД — каждую ночь в 03:00"
  on_app "( crontab -l 2>/dev/null | grep -v 'webreport backup' ; echo '0 3 * * * cd $APP_DIR && sh deploy/backup.sh >/dev/null 2>&1 # webreport backup' ) | crontab -"
  pw=$(on_app "grep '^ADMIN_PASSWORD=' $APP_DIR/.env | cut -d= -f2")
  save_secret ADMIN_PASSWORD "$pw"
  save_secret APP_URL "$url"
  ADMIN_PASSWORD=$pw
  APP_URL=$url
  say "Готово: $url — вход admin, пароль в deploy/.secrets"
}

api() {
  # api МЕТОД ПУТЬ [JSON] — запрос к приложению с сессией администратора
  curl -sk -b /tmp/wr-cookies -c /tmp/wr-cookies -X "$1" -H 'Content-Type: application/json' ${3:+--data "$3"} "$APP_URL$2"
}
json() { node -e 'const o={};for(const a of process.argv.slice(1)){const i=a.indexOf("=");const k=a.slice(0,i);let v=a.slice(i+1);if(v==="true")v=true;else if(v==="false")v=false;o[k]=v}process.stdout.write(JSON.stringify(o))' "$@"; }

step_configure() {
  [ -n "${APP_URL:-}" ] || die "Сначала шаг app (нет APP_URL в deploy/.secrets)"
  need ADMIN_PASSWORD
  rm -f /tmp/wr-cookies
  say "Вход администратором в $APP_URL"
  api POST /api/auth/login "$(json login=admin password="$ADMIN_PASSWORD")" | grep -q '"user"' || die "Не удалось войти"
  api PUT /api/notify/settings/app-url "$(json url="$APP_URL")" >/dev/null
  if [ -n "${SMTP_HOST:-}" ]; then
    say "Почтовый сервер $SMTP_HOST:$SMTP_PORT"
    body=$(json host="$SMTP_HOST" port="$SMTP_PORT" security="${SMTP_SECURITY:-starttls}" user="${SMTP_USER:-}" password="${SMTP_PASSWORD:-}" \
      fromName="${SMTP_FROM_NAME:-Веб отчётность}" fromAddress="${SMTP_FROM_ADDRESS:-}" tlsVerify="${SMTP_TLS_VERIFY:-true}" \
      allowedDomains="${MAIL_ALLOWED_DOMAINS:-}" to="${MAIL_TEST_TO:-}")
    api POST /api/notify/settings/mail/test "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);(r.steps||[]).forEach(x=>console.log((x.ok?"  ✓ ":"  ✕ ")+x.text));if(r.error)console.log("  ✕ "+r.error)})'
    api PUT /api/notify/settings/mail "$body" >/dev/null && echo "  сохранено"
  fi
  rm -f /tmp/wr-cookies
}

step_status() {
  url=${APP_URL:-https://${APP_DOMAIN:-$APP_HOST}}
  say "Приложение $url"
  curl -sk -m 10 "$url/api/health" && echo
  curl -s -o /dev/null -m 10 -w "HTTP → %{http_code} %{redirect_url}\n" "http://${APP_DOMAIN:-$APP_HOST}/" || true
  on_app "cd $APP_DIR && sh deploy/compose.sh ps" || true
  say "Порт БД снаружи должен быть закрыт"
  if command -v nc >/dev/null 2>&1; then nc -z -w 3 "$APP_HOST" 3306 && echo "!! 3306 открыт" || echo "3306 закрыт"; else echo "проверьте: nmap $APP_HOST -p 3306"; fi
}

case "${1:-}" in
  check) step_check ;;
  docker) step_docker ;;
  bundle) step_bundle ;;
  app) step_app ;;
  configure) step_configure ;;
  status) step_status ;;
  all) step_check; step_docker; step_bundle; step_app; step_configure; step_status ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
