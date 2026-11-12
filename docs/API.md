# REST API Reference — LedgerLine / BalanceVault

Base URL: `http://localhost:8080/api` (or your deployed domain `/api`)

All monetary values (`amount`, `balance`, `totalDebits`, `totalCredits`, etc.) are represented as **integer minor units (cents)** — for example, `10000` equals `$100.00` — to prevent floating-point rounding drift.

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
- **Rate Limiting Headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` on HTTP `429`):**
  - Auth routes (`/api/auth/login`, `/api/auth/register`, `/api/auth/bootstrap`): default `30` requests/min per IP (`AUTH_RATE_LIMIT_MAX`).
  - General `/api/*` routes: default `500` requests/min per IP (`RATE_LIMIT_MAX_REQUESTS`).

---

## 2. Health & Readiness

### `GET /api/health`
Public liveness check.
- **Response (`200 OK`):**
  ```json
  { "status": "UP", "service": "LedgerLine / BalanceVault API", "timestamp": "2026-11-12T06:00:00.000Z" }
  ```

### `GET /api/ready`
Public readiness probe verifying SQLite database connectivity (`SELECT 1`).
- **Response (`200 OK`):**
  ```json
  { "status": "READY", "database": "CONNECTED" }
  ```

---

## 3. Authentication & Onboarding (FR-1, FR-2, FR-4, FR-6, FR-7)

### `POST /api/auth/register`
Public self-registration for new `ACCOUNT_HOLDER` accounts. Users start with `status: "PENDING_APPROVAL"` and cannot log in until approved by an `ADMIN`. Any `role` other than `ACCOUNT_HOLDER` is rejected with `403 FORBIDDEN_SELF_REGISTRATION_ROLE`.
- **Request Body:**
  ```json
  {
    "username": "new_user",
    "email": "new_user@example.com",
    "password": "StrongPassword123!"
  }
  ```
- **Validation Errors:**
  - `400 MISSING_FIELDS`: Missing required fields
  - `400 PASSWORD_TOO_SHORT`: Password under 8 characters
  - `403 FORBIDDEN_SELF_REGISTRATION_ROLE`: Non-holder role requested on public endpoint
  - `409 USER_ALREADY_EXISTS`: Username or email already registered
- **Response (`201 Created`):** User object (`id`, `username`, `email`, `role`, `status`).

### `POST /api/auth/login`
Authenticates an `ACTIVE` user and issues an HMAC-SHA256 JWT token. Failed logins are recorded in `audit_logs`.
- **Request Body:**
  ```json
  { "username": "alice", "password": "AlicePassword123!" }
  ```
- **Response (`200 OK`):**
  ```json
  {
    "token": "<jwt>",
    "user": { "id": "...", "username": "alice", "email": "alice@ledgerline.local", "role": "ACCOUNT_HOLDER", "status": "ACTIVE" }
  }
  ```
- **Error Codes:**
  - `401 INVALID_CREDENTIALS`
  - `403 ACCOUNT_PENDING_APPROVAL` / `403 ACCOUNT_DEACTIVATED`

### `GET /api/auth/bootstrap-status`
Public check returning `{ "needsBootstrap": true | false }` indicating whether zero `ADMIN` users exist and First-Admin Bootstrap is required.

### `POST /api/auth/bootstrap`
First-admin bootstrap endpoint (FR-4). Succeeds **only** when zero non-system `ADMIN` users exist in the database.
- **Request Body:** `{ "username": "...", "email": "...", "password": "..." }`
- **Error Code:** `409 ADMIN_ALREADY_BOOTSTRAPPED` once an admin exists.

### `GET /api/auth/me`
Returns the authenticated user's profile.
- **Auth:** Any authenticated role (`ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`).

---

## 4. Accounts & Ownership (FR-3, FR-8, FR-9)

### `GET /api/accounts`
- `ACCOUNT_HOLDER`: Returns **only** accounts owned by the authenticated user.
- `ADMIN` / `AUDITOR`: Returns all accounts (including `owner_username`).

### `GET /api/accounts/recipients?excludeAccountId=<id>`
Returns active customer recipient directory (`id`, `account_number`, `account_type`, `currency`, `owner_username`) for transfers without exposing sensitive user emails or account balances. Excludes `SYSTEM_CLEARING`.
- **Auth:** Any authenticated role.

### `POST /api/accounts`
Opens a new `CHECKING` or `SAVINGS` account owned by the caller.
- **Auth:** `ACCOUNT_HOLDER`, `ADMIN`.
- **Request Body:**
  ```json
  { "accountType": "SAVINGS", "currency": "USD" }
  ```
- **Response (`201 Created`):** Created account object (`id`, `account_number`, `owner_id`, `account_type`, `currency`, `balance`, `status`).

### `GET /api/accounts/:id`
Retrieves single account details. Enforces FR-3 ownership check (`403 UNAUTHORIZED_ACCOUNT_ACCESS` if another `ACCOUNT_HOLDER` requests it).

### `GET /api/accounts/:id/statement`
Computes the chronological running-balance account statement directly from `ledger_entries` and verifies reconciliation (`calculated_balance === current_balance`). Enforces FR-3 ownership check.
- **Response (`200 OK`):**
  ```json
  {
    "account": { ... },
    "current_balance": 100000,
    "calculated_balance": 100000,
    "is_balance_consistent": true,
    "statement_entries": [ { "entry_id": "...", "transaction_type": "DEPOSIT", "direction": "CREDIT", "amount": 100000, "running_balance": 100000, ... } ]
  }
  ```

---

## 5. Money Movement & Idempotency (FR-10 to FR-16)

All write operations run inside SQLite `BEGIN IMMEDIATE` exclusive transactions, generate balanced double-entry `DEBIT` and `CREDIT` lines, check account `status === 'ACTIVE'`, and enforce `Idempotency-Key`.

### `POST /api/transactions/deposit`
Credits a customer account and debits the `SYSTEM_CLEARING` vault. Enforces ownership check for `ACCOUNT_HOLDER`.
- **Headers:** `Idempotency-Key: <key>`
- **Auth:** `ACCOUNT_HOLDER`, `ADMIN`
- **Body:** `{ "accountId": "...", "amount": 10000, "description": "Payroll Deposit" }`

### `POST /api/transactions/withdraw`
Debits a customer account and credits the `SYSTEM_CLEARING` vault. Fails atomically with `400 INSUFFICIENT_FUNDS` if `balance < amount`.
- **Headers:** `Idempotency-Key: <key>`
- **Auth:** `ACCOUNT_HOLDER`, `ADMIN`
- **Body:** `{ "accountId": "...", "amount": 1000, "description": "ATM Withdrawal" }`

### `POST /api/transactions/transfer`
Zero-sum transfer between two customer accounts. Accepts either `destinationAccountId` or `destinationAccountNumber` (e.g. `ACC-12345678`).
- **Headers:** `Idempotency-Key: <key>`
- **Auth:** `ACCOUNT_HOLDER`, `ADMIN`
- **Body:**
  ```json
  {
    "sourceAccountId": "acc_...",
    "destinationAccountNumber": "ACC-12345678",
    "amount": 2500,
    "description": "Rent share"
  }
  ```

### `GET /api/transactions?accountId=<id>&limit=50&offset=0`
Lists transactions. For `ACCOUNT_HOLDER`, results are scoped strictly to transactions involving accounts owned by that user (`403 UNAUTHORIZED_ACCOUNT_ACCESS` if querying someone else's `accountId`).

### Idempotency Behavior (FR-15)
- Repeating a request with the **same `Idempotency-Key` and identical payload** returns the cached response (`200 OK`) with `"isCached": true` and creates no duplicate ledger entries.
- Reusing the **same `Idempotency-Key` with a different payload or endpoint** returns `422 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`.

---

## 6. Ledger Conservation & Audit Trail (FR-17 to FR-21)

### `GET /api/ledger/conservation`
Authenticated verification endpoint returning `is_valid`, `ledger_stats` (`total_debits`, `total_credits`, `difference`, `total_entries`), `balance_stats` (`total_customer_balances`, `clearing_vault_balance`, `is_consistent`), and `unbalanced_transactions_count`.
- **Auth:** Any authenticated role (`ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`).

### `GET /api/ledger/entries?transactionType=&direction=&limit=100`
Returns raw double-entry ledger lines joined with transactions and accounts.
- **Auth:** `AUDITOR`, `ADMIN`.

### `GET /api/audit/logs?status=&entityType=&actorId=&limit=100`
Returns append-only audit trail entries (`SUCCESS`, `FAILURE`, `UNAUTHORIZED`). Protected by DB triggers preventing `UPDATE` and `DELETE`.
- **Auth:** `AUDITOR`, `ADMIN`.

---

## 7. Administration Endpoints (FR-2, FR-7, FR-9)

All `/api/admin/*` endpoints require `role === 'ADMIN'`. Unauthorized access attempts return `403` and record an `UNAUTHORIZED` entry in `audit_logs`.

### `GET /api/admin/users?status=&role=`
Lists non-system users.

### `POST /api/admin/users`
Admin-only user provisioning (supports `ADMIN`, `ACCOUNT_HOLDER`, `AUDITOR`, immediately `ACTIVE`).
- **Body:** `{ "username": "...", "email": "...", "password": "...", "role": "AUDITOR" }`

### `POST /api/admin/users/:id/activate`
Approves a `PENDING_APPROVAL` user (or re-activates a `DEACTIVATED` user) to `ACTIVE`.

### `POST /api/admin/users/:id/deactivate`
Deactivates an active user (blocks admin self-deactivation).

### `POST /api/admin/accounts/:id/status`
Updates an account's operational status (`ACTIVE`, `FROZEN`, `CLOSED`). Rejects modifications to `SYSTEM_CLEARING`. `FROZEN` or `CLOSED` accounts cannot send or receive money (`400 ACCOUNT_NOT_ACTIVE`).
- **Body:** `{ "status": "FROZEN" }`

### `GET /api/admin/stats`
Returns `{ "stats": { "users": { total_users, pending_users, active_users }, "accounts": { total_accounts, total_balances }, "transactions": { total_transactions, total_volume }, "audit": { total_audit_entries } } }`.

### `POST /api/admin/reset-seed`
Clears transactional tables (`idempotency_keys`, `ledger_entries`, `transactions`, `accounts`, `users`) in foreign-key order without mutating `audit_logs`, re-seeds the demo dataset, and appends a `DEMO_DATABASE_RESET` audit record.
