# «Веб отчётность» — образ приложения (Debian 12 bookworm + Node.js 24 LTS).
# Сборка в три стадии: веб-интерфейс (Vite), сервер (esbuild), итоговый образ без dev-зависимостей.

# ---------- 1. Веб-интерфейс ----------
FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY shared ./shared
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

# ---------- 2. Сервер ----------
FROM node:24-bookworm-slim AS server
WORKDIR /build
COPY shared ./shared
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund
COPY server ./server
RUN cd server && npm run typecheck && npm run build && npm prune --omit=dev

# ---------- 3. Итоговый образ ----------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    TZ=Asia/Yekaterinburg \
    APP_TZ=Asia/Yekaterinburg
WORKDIR /app
COPY --from=server /build/server/package.json ./package.json
COPY --from=server /build/server/node_modules ./node_modules
COPY --from=server /build/server/dist ./dist
COPY --from=web /build/web/dist ./public
COPY db/init/01-schema.sql ./db/01-schema.sql
COPY db/demo ./db/demo
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
