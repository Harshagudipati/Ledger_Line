# Deployment Guide — LedgerLine / BalanceVault

LedgerLine / BalanceVault has **zero third-party runtime dependencies** and runs cleanly on **Node.js 22+ / 24 LTS** (single server serving both the REST API under `/api/*` and the frontend static assets from `frontend/`).

---

## 1. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port (`0.0.0.0:$PORT` — automatically injected by Render, Railway, and Fly.io) |
| `DB_PATH` | `backend/ledgerline.sqlite` | SQLite database file path. Point to a persistent disk mount (e.g. `/data/ledgerline.sqlite`) in production |
| `JWT_SECRET` | `ledgerline-super-secret-key-2026-vvit-challenge` | **Required in hosted deployments:** Set a high-entropy 32+ character secret |
| `AUTH_RATE_LIMIT_MAX` | `30` | Maximum requests per minute per IP on `/api/auth/login`, `/api/auth/register`, and `/api/auth/bootstrap` |
| `RATE_LIMIT_MAX_REQUESTS` | `500` | Maximum requests per minute per IP on general `/api/*` endpoints |
| `SKIP_AUTO_SEED` | unset (`false`) | Set to `true` only if booting a completely blank database intended for first-admin bootstrap (`POST /api/auth/bootstrap`) |

---

## 2. Local Verification Before Deploy

```bash
# Run all 6 automated test suites
npm test

# Start the server locally
npm start
# Open http://localhost:8080
```

On startup (unless `SKIP_AUTO_SEED=true`), `ensureSeeded()` initializes the SQLite schema, seeds the Clearing Vault and demo personas (`alice`, `bob`, `charlie`, `admin`, `auditor`), and verifies double-entry conservation automatically.

---

## 3. Deploying with Docker (Any Cloud / VM)

```bash
# Build image
docker build -t ledgerline:latest .

# Run container with persistent SQLite volume and production JWT secret
docker run -d \
  --name ledgerline \
  -p 8080:8080 \
  -e JWT_SECRET="replace-with-random-64-char-hex-secret" \
  -e DB_PATH="/data/ledgerline.sqlite" \
  -v ledgerline_data:/data \
  ledgerline:latest
```

Verify container health:
```bash
curl http://localhost:8080/api/health
curl http://localhost:8080/api/ready
```

---

## 4. Platform-Specific One-Click Cloud Options

### Option A: Render (Web Service)
1. Push your repository to GitHub (`https://github.com/Harshagudipati/ledgerline`).
2. Create a **New Web Service** on Render pointing to the repo.
3. Choose either:
   - **Docker Runtime** (automatically uses `Dockerfile`), **or**
   - **Node Runtime** with **Build Command:** `echo "Zero dependencies"` and **Start Command:** `node backend/src/server.js` (ensure Node 24 is selected via `NODE_VERSION=24` env var).
4. Set environment variables:
   - `JWT_SECRET` = generate a strong random value
   - `DB_PATH` = `/data/ledgerline.sqlite` (if attaching a Render Persistent Disk at `/data`) or omit to use `/app/backend/ledgerline.sqlite` for ephemeral demo resets.
5. Set Health Check Path to `/api/health`.

### Option B: Railway
1. Connect your GitHub repository in Railway.
2. Railway automatically detects the `Dockerfile`.
3. Add a **Volume** mounted at `/data` and set:
   - `DB_PATH=/data/ledgerline.sqlite`
   - `JWT_SECRET=<random-secret>`
4. Generate a public domain under **Settings -> Networking**.

### Option C: Fly.io
1. Install `flyctl` and initialize without overwriting `Dockerfile`:
   ```bash
   fly launch --no-deploy
   fly volumes create ledgerline_data --size 1
   ```
2. Mount `ledgerline_data` at `/data` in `fly.toml`, set secrets, and deploy:
   ```bash
   fly secrets set JWT_SECRET="$(openssl rand -hex 32)" DB_PATH="/data/ledgerline.sqlite"
   fly deploy
   ```

---

## 5. Production Database Option: PostgreSQL DDL

For teams extending LedgerLine beyond embedded SQLite/WAL to managed PostgreSQL (RDS / Cloud SQL / Neon / Supabase), the full equivalent schema is provided in:
- [`backend/src/db/schema.postgres.sql`](../backend/src/db/schema.postgres.sql)

It preserves:
- Minor-unit `BIGINT` amounts (`balance BIGINT CHECK (balance >= 0)`)
- Foreign keys with `ON DELETE RESTRICT`
- PL/pgSQL triggers (`prevent_audit_log_update`, `prevent_audit_log_delete`) enforcing strict append-only immutability on `audit_logs`
- Deterministic row-level locking notes (`ORDER BY id FOR UPDATE`) and restricted bootstrap role template (`FR-4`).

---

## 6. First-Admin Bootstrap Workflow (FR-4)

When running with `SKIP_AUTO_SEED=true` on a fresh database with zero active `ADMIN` users:
```bash
curl -X POST https://your-deployed-url.example.com/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "username": "platform_admin",
    "email": "admin@example.com",
    "password": "StrongAdminPassword123!"
  }'
```
Once one `ADMIN` exists, `/api/auth/bootstrap` returns `409 ADMIN_ALREADY_BOOTSTRAPPED` permanently.
