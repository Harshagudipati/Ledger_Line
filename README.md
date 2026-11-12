# LedgerLine / BalanceVault

[![Double-Entry Invariance](https://img.shields.io/badge/Double--Entry-Zero--Sum%20Conserved-emerald?style=for-the-badge&logo=cashapp)](https://github.com/Harshagudipati/ledgerline)
[![Concurrency](https://img.shields.io/badge/Concurrency%20Test-100%20Parallel%20Safe-blue?style=for-the-badge&logo=lightning)](https://github.com/Harshagudipati/ledgerline)
[![Audit Immutability](https://img.shields.io/badge/Audit%20Trail-Append--Only%20Protected-indigo?style=for-the-badge&logo=shield)](https://github.com/Harshagudipati/ledgerline)
[![Tests](https://img.shields.io/badge/Automated%20Tests-7%2F7%20Passed-green?style=for-the-badge&logo=checkmarx)](https://github.com/Harshagudipati/ledgerline)

**Event:** Snovasys Fresher Hiring Challenge 2026 (VVIT)  
**Author:** Harsha Gudipati ([@Harshagudipati](https://github.com/Harshagudipati))  
**Repository:** [https://github.com/Harshagudipati/ledgerline](https://github.com/Harshagudipati/ledgerline)

---

## 📖 Executive Summary

**LedgerLine** is a money-movement engine built around a mathematically provable, double-entry general ledger. Every financial transaction produces balanced debit and credit entries ($\sum \text{Debits} = \sum \text{Credits}$) with integer-cent storage (`100` = `$1.00`), preventing arbitrary balance inflation or floating-point drift.

**BalanceVault** adds production enterprise governance:
- **Modular React + Vite Frontend** with strict login gate, role-isolated workspaces (**Account Holder**, **Administrator**, **Auditor**), First-Admin Bootstrap wizard, and self-service password rotation
- **Server-Side Session Revocation & Lockout:** JWT `jti` blocklist (`revoked_tokens`) on logout/password change plus automated failed-login lockout (`MAX_FAILED_LOGINS`)
- **Dual Database & Limiter Adapters:** Zero-dependency **SQLite WAL** + in-memory sliding-window defaults for local/test speed, seamlessly switchable to **PostgreSQL (`DATABASE_URL` + `FOR UPDATE` locking + least-privilege roles)** and **Redis (`REDIS_URL` pure-Node RESP2 sliding window)**
- **Observability & Compliance:** Structured JSON logs, `X-Request-Id` correlation headers, `/api/metrics` runtime telemetry, filtered statements, atomic account close with balance sweep, and CSV audit export

---

## 🏛️ System Architecture

```
                            ┌────────────────────────────────┐
                            │   React 18 + Vite Web Console  │
                            │ (Auth, Holder, Admin, Auditor) │
                            └───────────────┬────────────────┘
                                            │ HTTP (REST + JWT + Idempotency-Key)
                                            ▼
                       ┌──────────────────────────────────────────┐
                       │           Node.js API & Telemetry        │
                       │  - TelemetryCollector & X-Request-Id     │
                       │  - RateLimiter (Redis RESP2 / Memory)    │
                       │  - JWT jti Revocation & Lockout Guards   │
                       └────────────────────┬─────────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
              ▼                             ▼                             ▼
   ┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
   │    Account Service   │      │    Ledger Engine     │      │    Audit Service     │
   │  - Ownership Checks  │      │  - Double-Entry D/C  │      │  - Append-Only Log   │
   │  - Close & Sweep     │      │  - Idempotency Hash  │      │  - CSV Export        │
   └──────────┬───────────┘      └──────────┬───────────┘      └──────────┬───────────┘
              │                             │                             │
              └─────────────────────────────┼─────────────────────────────┘
                                            │
                                            ▼
                       ┌──────────────────────────────────────────┐
                       │    SQLite WAL / PostgreSQL Adapter Layer │
                       │  - Exclusive Locks / SELECT FOR UPDATE   │
                       │  - CHECK (balance >= 0) Constraint       │
                       │  - Immutability Database Triggers        │
                       └──────────────────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md), [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md), and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## 🎯 Verification Coverage (7/7 Suites Passing)

| Verification Suite | What It Proves | Test File |
|---|---|---|
| **1. Concurrency Protection** | 100 parallel \$10 withdrawals on \$100 account allow exactly 10, zero overdrafts | [`backend/tests/concurrency.test.js`](backend/tests/concurrency.test.js) |
| **2. Idempotency Protection** | Exact replay serves cached response; tampered payload rejected (`422`) | [`backend/tests/idempotency.test.js`](backend/tests/idempotency.test.js) |
| **3. Double-Entry Conservation** | Every transaction balances; `total_debits === total_credits`; statement reconciliation | [`backend/tests/ledger.test.js`](backend/tests/ledger.test.js) |
| **4. Security & RBAC** | Cross-account access blocked; pending login blocked; admin activation/deactivation | [`backend/tests/security.test.js`](backend/tests/security.test.js) |
| **5. Audit Immutability** | Database triggers abort direct `UPDATE` and `DELETE` on `audit_logs` | [`backend/tests/audit.test.js`](backend/tests/audit.test.js) |
| **6. HTTP E2E & Rate Limit** | Health/readiness, bootstrap wizard, recipients privacy, account freeze, `429` limits | [`backend/tests/http.e2e.test.js`](backend/tests/http.e2e.test.js) |
| **7. Security & Operations v1.1** | `logout` token revocation, password rotation, 5-attempt lockout, close sweep, `/api/metrics`, CSV export, migrations | [`backend/tests/improvements.test.js`](backend/tests/improvements.test.js) |

---

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js**: v22+ or v24+ (uses built-in `node:sqlite`, `node:crypto`, `node:net`)

### 1. Clone, Configure & Build Frontend
```bash
git clone https://github.com/Harshagudipati/ledgerline.git
cd ledgerline
cp .env.example .env        # Optional: configure custom ports/passwords/PG/Redis
npm run setup:frontend
npm run build
```

### 2. Run Migrations, Seed & Automated Verification
```bash
npm run migrate
npm run seed                # Prints generated or .env demo credentials
npm test                    # Runs all 7 test suites
```

### 3. Start Application
```bash
npm start
# Open http://localhost:8080
```
*(Optional Vite dev mode with hot reload: run `npm start` + `npm run dev:frontend` in two terminals and open `http://localhost:5173`.)*

---

## 📂 Repository Structure

```
ledgerline/
├── .env.example                   # Environment template (zero secrets committed)
├── .github/workflows/ci.yml       # GitHub Actions CI (Node 22 & 24 build + 7 suites)
├── Dockerfile                     # Multi-stage React Vite + Node 24 production build
├── package.json                   # Root scripts (start, migrate, seed, build, test)
├── backend/
│   ├── src/
│   │   ├── config.js              # Lightweight .env loader & fail-fast prod secret check
│   │   ├── server.js              # HTTP API router, metrics, CSV export & SPA static host
│   │   ├── db/
│   │   │   ├── database.js        # Unified SqliteAdapter & PgAdapter transaction layer
│   │   │   ├── migrate.js         # Idempotent migration runner (schema_migrations)
│   │   │   ├── schema.sql         # SQLite DDL, constraints & immutability triggers
│   │   │   ├── schema.postgres.sql# PostgreSQL DDL & PL/pgSQL triggers
│   │   │   ├── postgresRoles.sql  # Least-privilege PG roles & bootstrap function
│   │   │   └── seed.js            # Env-driven / random-password seed & audit-safe reset
│   │   ├── middleware/
│   │   │   ├── auth.js            # Async JWT verification & revoked_tokens check
│   │   │   ├── rateLimiter.js     # Pure-Node Redis RESP2 sliding window + memory fallback
│   │   │   └── telemetry.js       # X-Request-Id, structured JSON logs & /api/metrics
│   │   └── services/
│   │       ├── authService.js     # Register, login lockout, logout revoke, password rotation
│   │       ├── accountService.js  # Ownership isolation, filtered statements, close sweep
│   │       ├── ledgerService.js   # Double-entry, idempotency registry, conservation proof
│   │       ├── auditService.js    # Append-only search/filter queries & recording
│   │       └── adminService.js    # Provisioning, unlock/activate, stats
│   └── tests/                     # 7 automated verification suites + testFixtures.js
├── frontend/                      # Modular React 18 + Vite application
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── api/client.js          # Fetch client, integer cents helpers & CSV downloader
│       ├── components/            # ToastContainer & ChangePasswordModal
│       └── pages/                 # AuthPage, HolderDashboard, AdminDashboard, AuditorDashboard
└── docs/                          # API.md, ARCHITECTURE.md, DEMO_GUIDE.md, DEPLOYMENT.md
```

---

## 📜 License
This project is licensed under the MIT License.
