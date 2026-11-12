# Deployment Guide — LedgerLine / BalanceVault

LedgerLine / BalanceVault runs cleanly on **Node.js 22+ / 24 LTS** (serving both the REST API under `/api/*` and the compiled React + Vite dashboard from `frontend/dist/`). It supports zero-dependency **SQLite WAL + in-memory sliding-window** mode out of the box, or **PostgreSQL + Redis** in distributed production deployments.

---

## 1. Environment Variables (`.env.example`)

Copy `.env.example` to `.env` for local configuration or inject variables directly into your container runtime:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port (`0.0.0.0:$PORT`) |
| `JWT_SECRET` | Auto-generated in dev; **required in prod** | **Fail-fast in `NODE_ENV=production`:** startup aborts unless a strong `JWT_SECRET` is provided |
| `DB_PATH` | `backend/ledgerline.sqlite` | SQLite database file path (ignored when `DATABASE_URL` is set) |
| `DATABASE_URL` | unset | PostgreSQL connection string (`postgres://...`). Uses `PgAdapter` + `schema.postgres.sql` + `ORDER BY id ASC FOR UPDATE` (requires optional `npm install pg`) |
| `REDIS_URL` | unset | Redis connection URL (`redis://...` or `rediss://...`). Uses built-in pure-Node RESP2 sliding-window limiter with automatic in-memory fallback |
| `AUTH_RATE_LIMIT_MAX` | `30` | Max requests per minute per IP on auth routes |
| `RATE_LIMIT_MAX_REQUESTS` | `500` | Max requests per minute per IP on general `/api/*` routes |
| `MAX_FAILED_LOGINS` | `5` | Consecutive failed passwords before account lockout |
| `LOCKOUT_DURATION_MS` | `900000` (15m) | Duration of brute-force lockout window |
| `SEED_DEMO_USERS` | `true` in dev, `false` in prod | Auto-seed demo personas when DB is empty |
| `SEED_*_PASSWORD` | random if unset | Optional deterministic seed passwords for `.env` (never committed to git) |
| `SKIP_AUTO_SEED` | `false` | Set `true` for blank production DBs using `POST /api/auth/bootstrap` |
| `APPLY_PG_ROLES` | `false` | Set `true` during `npm run migrate` on PostgreSQL to install `postgresRoles.sql` |

---

## 2. Build & Local Verification Before Deploy

```bash
# 1. Install and build React + Vite frontend into frontend/dist/
npm run setup:frontend
npm run build

# 2. Run database migrations & optional demo seed
npm run migrate
npm run seed

# 3. Run all 7 automated verification suites
npm test

# 4. Start backend API + built React SPA server
npm start
# Open http://localhost:8080
```

For frontend hot-reload during development, run `npm start` in one terminal (`:8080`) and `npm run dev:frontend` (`:5173`, proxies `/api` to `:8080`) in a second terminal.

---

## 3. Deploying with Docker (Multi-Stage React + Node 24)

The included [`Dockerfile`](../Dockerfile) builds `frontend/dist/` cleanly in Stage 1 and ships a minimal Node 24 LTS Stage 2 runtime image:

```bash
# Build image
docker build -t ledgerline:latest .

# Run container with persistent SQLite volume and production JWT secret
docker run -d \
  --name ledgerline \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e DB_PATH="/data/ledgerline.sqlite" \
  -v ledgerline_data:/data \
  ledgerline:latest
```

Verify container health and readiness:
```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/ready
```

---

## 4. Production PostgreSQL & Least-Privilege Roles (FR-4 / FR-24)

When `DATABASE_URL` is configured (`npm install pg` alongside deployment):
1. `PgAdapter` applies [`backend/src/db/schema.postgres.sql`](../backend/src/db/schema.postgres.sql), enforcing `BIGINT` minor units (`CHECK (balance >= 0)`), `ON DELETE RESTRICT` foreign keys, and PL/pgSQL `audit_logs` immutability triggers.
2. Row-level deadlocks are prevented using deterministic `ORDER BY id ASC FOR UPDATE` locking.
3. [`backend/src/db/postgresRoles.sql`](../backend/src/db/postgresRoles.sql) defines separated least-privilege roles (`ledgerline_app`, `ledgerline_auditor`, `ledgerline_bootstrap`) plus a `SECURITY DEFINER` `bootstrap_first_admin` function so runtime application workers have zero DDL permissions.

---

## 5. Cloud Platforms (Render / Railway / Fly.io)

1. Push to GitHub (`Harshagudipati/ledgerline`) — GitHub Actions (`.github/workflows/ci.yml`) validates the React build and all 7 backend suites on Node 22 & 24.
2. Deploy via **Docker Runtime** (auto-detects `Dockerfile`) or Node 24 (`npm --prefix frontend install && npm run build`, start `node backend/src/server.js`).
3. Set `NODE_ENV=production`, a 64-character random `JWT_SECRET`, and either a persistent `/data` disk (`DB_PATH=/data/ledgerline.sqlite`) or managed PostgreSQL (`DATABASE_URL`) + Redis (`REDIS_URL`).
4. Configure health probe to `GET /api/health` and readiness probe to `GET /api/ready`.

---

## 6. First-Admin Bootstrap Workflow (FR-4)

When running on an unseeded production database (`SEED_DEMO_USERS=false` or `SKIP_AUTO_SEED=true`):
1. Open the React UI in your browser — `/api/auth/bootstrap-status` detects zero admins and automatically displays the **Initialize Root Administrator** setup wizard, **or** submit directly:
```bash
curl -X POST https://your-deployed-url.example.com/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "username": "platform_admin",
    "email": "admin@example.com",
    "password": "StrongAdminPassword123!"
  }'
```
2. Once the first `ADMIN` exists, `/api/auth/bootstrap` permanently returns `409 ADMIN_ALREADY_BOOTSTRAPPED`.
