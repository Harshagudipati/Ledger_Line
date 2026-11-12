# Production Multi-Stage Dockerfile for LedgerLine / BalanceVault

# Stage 1: Build modular React + Vite SPA
FROM node:24-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Minimal Node.js 24 LTS Runtime (built-in node:sqlite + optional pg/Redis)
FROM node:24-alpine
WORKDIR /app

COPY package.json ./
COPY backend/ ./backend/
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Persistent SQLite volume mount directory (when using PostgreSQL via DATABASE_URL, this stays unused)
RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/ledgerline.sqlite

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "backend/src/server.js"]
