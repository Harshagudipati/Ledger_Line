# Production Dockerfile for LedgerLine / BalanceVault
# Zero external npm dependencies; runs on Node.js 24 LTS with built-in node:sqlite
FROM node:24-alpine

WORKDIR /app

# Copy application metadata, backend, and frontend static files
COPY package.json ./
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Directory for persistent SQLite volume mounts (override via DB_PATH)
RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/ledgerline.sqlite

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "backend/src/server.js"]
