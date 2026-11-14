#!/bin/sh
# Релизные файлы без Docker (на любой машине): исходники.
# Комплект с образами собирает deploy/build-bundle.sh на машине с Docker
# или GitHub Actions по тегу v* (.github/workflows/release.yml).
#
#   sh deploy/make-release.sh 1.0.0   → release/
set -eu

cd "$(dirname "$0")/.."
V=${1:-1.0.0}
OUT=release
mkdir -p "$OUT"
rm -f "$OUT"/*"$V"*

echo "==> Исходники webreport-src-$V.tar.gz"
tar --exclude=node_modules --exclude=dist --exclude=dist-bundle --exclude=release --exclude=certs --exclude=backups \
    --exclude='.env' --exclude='.env.local' --exclude='deploy/servers.env' --exclude='deploy/.secrets' \
    --exclude='*.xlsx' --exclude='*.pdf' --exclude='.git' --exclude='*.log' \
    --transform "s,^,webreport-src-$V/," \
    -czf "$OUT/webreport-src-$V.tar.gz" \
    .dockerignore .gitattributes .gitignore .env.example .github CHANGELOG.md Dockerfile README.md \
    docker-compose.yml docker-compose.https.yml docker-compose.dbport.yml db deploy docs server shared tests web

cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then sha256sum ./*"$V"*.tar.gz > "SHA256SUMS-$V"; fi
ls -la
