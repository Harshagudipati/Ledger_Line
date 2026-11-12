# Evaluator & Demo Guide: LedgerLine / BalanceVault

**Event:** Snovasys Fresher Hiring Challenge 2026 (VVIT)  
**Author:** Harsha Gudipati ([@Harshagudipati](https://github.com/Harshagudipati))  
**Repository:** [https://github.com/Harshagudipati/ledgerline](https://github.com/Harshagudipati/ledgerline)

---

## 1. Quick Start

### Step 1: Configure Optional Environment Variables & Build UI
```bash
cp .env.example .env    # Optional: set SEED_*_PASSWORD or use random generated credentials
npm run setup:frontend  # Install React + Vite dependencies
npm run build           # Build production SPA to frontend/dist/
```

### Step 2: Run All 7 Automated Test Suites
```bash
npm test
```
*Executes 100-parallel-withdrawal concurrency protection, idempotency replay validation, double-entry conservation, RBAC & ownership isolation, append-only audit trigger immutability, HTTP E2E + rate limits, and session revocation / brute-force lockout / account close sweep / CSV export / migration runner checks.*

### Step 3: Launch the Full-Stack Web Application
```bash
npm start
```
Watch startup console output for generated (or `.env`-configured) demo persona credentials (`alice`, `bob`, `admin`, `auditor`, `charlie`), then open **[http://localhost:8080](http://localhost:8080)**.

---

## 2. Seeded Evaluation Personas

| Persona | Role | Username | Purpose |
|---|---|---|---|
| **Alice** | `ACCOUNT_HOLDER` | `alice` | Primary customer account (\$1,000.00 initial balance) |
| **Bob** | `ACCOUNT_HOLDER` | `bob` | Recipient customer account (\$500.00 initial balance) |
| **Admin** | `ADMIN` | `admin` | System operator; approves/unlocks users, freezes accounts & views telemetry |
| **Auditor** | `AUDITOR` | `auditor` | Read-only compliance; inspects ledger, audit trail & CSV exports |
| **Charlie** | `ACCOUNT_HOLDER` | `charlie` | Starts in `PENDING_APPROVAL` to demonstrate onboarding approval |

> [!NOTE]
> **Real Login Gate, No Secret Baking & Session Revocation:** LedgerLine ships with **zero hardcoded passwords** in source control. Configure known evaluation passwords via `.env` (`SEED_*_PASSWORD`) or copy the randomly generated passwords printed on first startup. Signing out invokes `POST /api/auth/logout`, adding the JWT `jti` to `revoked_tokens`.

---

## 3. Step-by-Step Feature Walkthrough

### Scenario A: Account Holder Money Movement, Idempotency Replay & Statement Filters
1. Sign in as **alice** on the React Sign In screen.
2. Execute a **Deposit** or **Transfer** to **bob** (pick from the privacy-preserving recipients dropdown or enter Bob's `ACC-...` number).
3. Click **"Replay Last Key"** inside the `Idempotency-Key` box and submit again — verify the UI receives the cached transaction without double-charging Alice (`Recent Idempotency Keys` updates cleanly).
4. Filter the **Account Statement & Running Balance** table by `Type`, date range, or search keyword while confirming true chronological running balances remain `VERIFIED`.
5. Click **"Open Account"** (`SAVINGS`), deposit funds, then test **"Close Account"** with atomic balance sweep back into Alice's primary Checking account!

### Scenario B: Onboarding, Brute-Force Lockout & Account Freeze (`ADMIN`)
1. On the Sign In page, try signing in as `charlie` (blocked with `ACCOUNT_PENDING_APPROVAL`), or try 5 wrong passwords on a test user to observe `429 ACCOUNT_TEMPORARILY_LOCKED`.
2. Sign in as **admin** to view **Admin Console**:
   - View live KPI cards & `/api/metrics` telemetry (`dbDialect`, `rateLimitBackend`, latency).
   - Click **Approve** / **Unlock / Activate** on pending or locked users.
   - Click **Freeze** on any customer account to block debits/credits with `ACCOUNT_NOT_ACTIVE`, then **Unfreeze**.
   - Click **Reset Demo State** to restore baseline balances while preserving every immutable audit row.

### Scenario C: Double-Entry Conservation & CSV Compliance Export (`AUDITOR`)
1. Sign out (revoking Admin JWT server-side) and sign in as **auditor** (or switch to the **Audit & Ledger** tab as Admin).
2. Inspect the global Conservation Proof ($\Delta = \$0.00$), search/filter `audit_logs`, and click **Export CSV** to download `ledgerline-audit-logs.csv`.
3. Filter the **Double-Entry Ledger Entries Inspector** by transaction type or `DEBIT`/`CREDIT` leg.

### Scenario D: Self-Service Password Rotation
1. Click **Password** in the sticky top header from any authenticated session.
2. Update your password via `POST /api/auth/change-password` — the backend revokes the previous JWT and rotates a fresh token into your browser automatically.
