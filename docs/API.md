# REST API Reference — LedgerLine / BalanceVault

Base URL: `http://localhost:8080/api` (or your deployed domain `/api`)

All monetary values (`amount`, `balance`, `total_debits`, `total_credits`, etc.) are represented as **integer minor units (cents)** — for example, `10000` equals `$100.00` — to prevent floating-point rounding drift.

---

## 1. Authentication, Headers & Rate Limiting

- **Bearer Token Header:**
  ```http
  Authorization: Bearer <jwt_token>
  ```
- **Idempotency Header (required for `POST /api/transactions/deposit`, `withdraw`, `transfer`):**
  ```http
  Idempotency-Key: <unique-client-key>
  ```
- **Correlation Header:** Every response includes `X-Request-Id` matching the JSON telemetry log entry.
- **Rate Limiting Headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` on HTTP `429`):**
  - Auth routes (`/api/auth/login`, `/api/auth/register`, `/api/auth/bootstrap`): default `30` requests/min per IP (`AUTH_RATE_LIMIT_MAX`).
  - General `/api/*` routes: default `500` requests/min per IP (`RATE_LIMIT_MAX_REQUESTS`).
  - Uses distributed **Redis** sliding-window sorted sets when `REDIS_URL` is configured, falling back automatically to in-memory sliding windows when unset.

---

## 2. Health, Readiness & Monitoring (FR-23)

### `GET /api/health`
Public liveness check.
- **Response (`200 OK`):**
  ```json
  { "status": "UP", "service": "LedgerLine / BalanceVault", "version": "1.1.0", "timestamp": "2026-11-12T06:00:00.000Z" }
  ```

### `GET /api/ready`
Public readiness probe verifying database connectivity (`SELECT 1`).
- **Response (`200 OK`):**
  ```json
  { "status": "READY", "database": "CONNECTED", "dialect": "sqlite", "rateLimiter": "memory", "timestamp": "..." }
  ```

### `GET /api/metrics`
Returns live service telemetry (`uptimeSeconds`, `totalRequests`, `avgLatencyMs`, `statusBuckets`, `authFailures`, `rateLimitBlocks`, `backends`, `memoryRssMb`, `recentRequests`).
- **Auth:** `ADMIN`, `AUDITOR`.

### `GET /api/openapi.json`
Returns the live OpenAPI `3.0.3` JSON specification describing all REST routes, schemas, and Bearer JWT authentication.
- **Auth:** Public.

### `GET /api/events/stream`
Opens an RBAC-scoped **Server-Sent Events (`text/event-stream`)** channel delivering real-time ledger (`transaction`), account lifecycle (`account`), and audit (`audit`) events filtered to the caller's role and owned accounts. Accepts `Authorization: Bearer <token>`.
- **Auth:** Any authenticated role.

---

## 3. Authentication, Sessions & Bootstrap (FR-1, FR-2, FR-4, FR-6, FR-7)

### `POST /api/auth/register`
Public self-registration for new `ACCOUNT_HOLDER` accounts. Users start with `status: "PENDING_APPROVAL"` and cannot log in until approved by an `ADMIN`. Any `role` other than `ACCOUNT_HOLDER` is rejected with `403 FORBIDDEN_SELF_REGISTRATION_ROLE`.
- **Body:** `{ "username": "...", "email": "...", "password": "..." }`
- **Response (`201 Created`):** User object (`id`, `username`, `email`, `role`, `status`).

### `POST /api/auth/login`
Authenticates an `ACTIVE` user and issues an HMAC-SHA256 JWT containing a unique `jti`. Repeated invalid attempts trigger a brute-force lockout (`MAX_FAILED_LOGINS`, default `5`) returning `429 ACCOUNT_TEMPORARILY_LOCKED`.
- **Body:** `{ "username": "...", "password": "..." }`
- **Response (`200 OK`):** `{ "token": "<jwt>", "user": { "id", "username", "email", "role", "status" } }`
- **Error Codes:** `401 INVALID_CREDENTIALS`, `403 ACCOUNT_PENDING_APPROVAL`, `403 ACCOUNT_DEACTIVATED`, `429 ACCOUNT_TEMPORARILY_LOCKED`.

### `POST /api/auth/logout`
Revokes the caller's active JWT (`jti`) immediately in `revoked_tokens` and records `USER_LOGOUT` in `audit_logs`. Subsequent requests using the revoked token fail with `401 TOKEN_REVOKED`.
- **Auth:** Any authenticated role.

### `POST /api/auth/change-password`
Self-service password rotation. Verifies `currentPassword`, updates PBKDF2-SHA512 hash/salt, revokes the prior JWT (`jti`), and returns a fresh `token`.
- **Auth:** Any authenticated role.
- **Body:** `{ "currentPassword": "...", "newPassword": "..." }`

### `GET /api/auth/bootstrap-status`
Public check returning `{ "needsBootstrap": true | false }` indicating whether zero non-system `ADMIN` users exist.

### `POST /api/auth/bootstrap`
First-admin bootstrap endpoint (FR-4). Succeeds **only** when zero non-system `ADMIN` users exist (`409 ADMIN_ALREADY_BOOTSTRAPPED` thereafter).
- **Body:** `{ "username": "...", "email": "...", "password": "..." }`

### `GET /api/auth/me`
Returns the authenticated user's profile.
- **Auth:** Any authenticated role.

---

## 4. Accounts, Ownership & Lifecycle (FR-3, FR-8, FR-9, FR-20)

### `GET /api/accounts`
- `ACCOUNT_HOLDER`: Returns **only** accounts owned by the authenticated user.
- `ADMIN` / `AUDITOR`: Returns all accounts (including `owner_username`).

### `GET /api/accounts/recipients?excludeAccountId=<id>`
Returns active customer recipient directory (`id`, `account_number`, `account_type`, `currency`, `owner_username`) for transfers without exposing emails or balances.

### `POST /api/accounts`
Opens a new `CHECKING` or `SAVINGS` account owned by the caller (or `ownerId` for `ADMIN`).
- **Auth:** `ACCOUNT_HOLDER`, `ADMIN`.
- **Body:** `{ "accountType": "SAVINGS", "currency": "USD" }`

### `GET /api/accounts/:id`
Retrieves single account details. Enforces FR-3 ownership check (`403 UNAUTHORIZED_ACCOUNT_ACCESS`).

### `GET /api/accounts/:id/statement?transactionType=&fromDate=&toDate=&search=`
Computes true chronological `running_balance` across all `ledger_entries` first (`calculated_balance === current_balance`) and optionally filters the returned `statement_entries` by type, date window, or description/idempotency search term.

### `GET /api/accounts/:id/statement/export?transactionType=&fromDate=&toDate=&search=`
Streams the filtered account statement with chronological running balances as `text/csv` (`ledgerline-statement-<accountNumber>.csv`). Enforces the same ownership rules as `/statement`.

### `POST /api/accounts/:id/close`
Atomically closes an `ACTIVE` account (`status -> 'CLOSED'`). If `balance > 0`, requires `destinationAccountId` or `destinationAccountNumber` and performs an atomic double-entry balance sweep inside the same transaction before closing.
- **Auth:** `ACCOUNT_HOLDER` (owner) or `ADMIN`.
- **Body:** `{ "destinationAccountId": "acc_..." }` (or `{ "destinationAccountNumber": "ACC-..." }`).

---

## 5. Money Movement & Idempotency (FR-10 to FR-18)

Write operations run inside exclusive/serialized ACID transactions (`BEGIN IMMEDIATE` on SQLite, ordered `SELECT ... FOR UPDATE` on PostgreSQL), enforce `status === 'ACTIVE'`, check `balance >= amount`, and require `Idempotency-Key`.

### `POST /api/transactions/deposit`
Credits a customer account and debits `SYSTEM_CLEARING`. Enforces ownership for `ACCOUNT_HOLDER`.
- **Headers:** `Idempotency-Key: <key>`
- **Body:** `{ "accountId": "...", "amount": 10000, "description": "Payroll Deposit" }`

### `POST /api/transactions/withdraw`
Debits a customer account and credits `SYSTEM_CLEARING`. Rejects overdrafts atomically with `400 INSUFFICIENT_FUNDS`.
- **Headers:** `Idempotency-Key: <key>`
- **Body:** `{ "accountId": "...", "amount": 1000, "description": "ATM Withdrawal" }`

### `POST /api/transactions/transfer`
Zero-sum transfer between two active customer accounts (`destinationAccountId` or `destinationAccountNumber`).
- **Headers:** `Idempotency-Key: <key>`
- **Body:** `{ "sourceAccountId": "...", "destinationAccountNumber": "ACC-12345678", "amount": 2500, "description": "Rent share" }`

### `GET /api/transactions?accountId=&type=&limit=50&offset=0`
Lists transactions scoped by account ownership for `ACCOUNT_HOLDER`.

### `GET /api/transactions/idempotency?limit=20`
Returns the caller's recent `idempotency_keys` registry (`key`, `request_path`, `status`, `response_code`, `created_at`).

### `GET /api/transactions/:id`
Returns a Double-Entry X-Ray payload for a single transaction: transaction metadata, `idempotency` fingerprint (`request_hash`), chronological `entries` (`DEBIT` -> `CREDIT`), and balanced `proof` (`totalDebits`, `totalCredits`, `balanced`). Enforces account ownership for `ACCOUNT_HOLDER`.

---

## 6. Ledger Conservation & Audit Trail (FR-14, FR-15, FR-19, FR-21)

### `GET /api/ledger/conservation`
Verifies global double-entry conservation (`total_debits === total_credits` and `total_customer_balances === clearing_vault_balance`).
- **Auth:** Any authenticated role.

### `GET /api/ledger/entries?transactionType=&direction=&limit=100`
Returns raw double-entry ledger lines joined with transactions and accounts.
- **Auth:** `AUDITOR`, `ADMIN`.

### `GET /api/audit/logs?status=&entityType=&actorId=&action=&search=&fromDate=&toDate=&limit=50&offset=0`
Searches and paginates append-only `audit_logs` records (protected by SQLite & PostgreSQL immutability triggers).
- **Auth:** `AUDITOR`, `ADMIN`.

### `GET /api/audit/logs/export?...`
Streams matching `audit_logs` rows as `text/csv` (`ledgerline-audit-logs.csv`).
- **Auth:** `AUDITOR`, `ADMIN`.

### `GET /api/audit/verify-chain`
Recomputes and verifies the SHA-256 hash chain (`prev_hash` -> `entry_hash`) sequentially across all `audit_logs` rows, proving tamper-free append-only history (`{ valid, totalEntries, headHash, firstBrokenId }`).
- **Auth:** `AUDITOR`, `ADMIN`.

---

## 7. Administration Endpoints (FR-2, FR-7, FR-9)

All `/api/admin/*` endpoints require `role === 'ADMIN'`.

- `GET /api/admin/users?status=&role=` — Lists users including `failed_login_attempts` and `locked_until`.
- `POST /api/admin/users` — Admin-only provisioning (`ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`, created `ACTIVE`).
- `POST /api/admin/users/:id/activate` — Activates a user and clears any failed-login lockout.
- `POST /api/admin/users/:id/deactivate` — Deactivates a user (blocks admin self-deactivation).
- `POST /api/admin/accounts/:id/status` — Sets account status (`ACTIVE`, `FROZEN`, `CLOSED`).
- `GET /api/admin/stats` — System user/account/transaction/audit aggregates.
- `POST /api/admin/reset-seed` — Resets demo operational tables in FK order while strictly preserving `audit_logs` and appending `DEMO_DATABASE_RESET`.
