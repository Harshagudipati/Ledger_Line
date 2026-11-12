# Evaluator & Demo Guide: LedgerLine / BalanceVault

**Event:** Snovasys Fresher Hiring Challenge 2026 (VVIT)  
**Author:** Harsha Gudipati ([@Harshagudipati](https://github.com/Harshagudipati))  
**Repository:** [https://github.com/Harshagudipati/ledgerline](https://github.com/Harshagudipati/ledgerline)

---

## 1. Quick Start (Zero Third-Party Dependency Installation Required)

This project is built using native Node.js (v20+ / v22+ / v24+) with zero external npm dependencies required for core database operations, cryptographic auth, transactions, and automated test execution.

### Step 1: Initialize Seed Data *(optional — server auto-seeds on first start)*
```bash
node backend/src/db/seed.js
```

### Step 2: Run All 6 Automated Test Suites
```bash
npm test
```
*Executes 100-parallel-withdrawal concurrency protection, idempotency validation, double-entry conservation, RBAC & ownership checks, audit immutability triggers, and full end-to-end HTTP API verification.*

### Step 3: Launch the Full-Stack Web Application
```bash
node backend/src/server.js
```
Open your browser at: **[http://localhost:8080](http://localhost:8080)**

---

## 2. Pre-Seeded Evaluation Personas

| Persona | Role | Username | Password | Purpose |
|---|---|---|---|---|
| **Alice** | Account Holder | `alice` | `AlicePassword123!` | Primary customer account (\$1,000.00 initial balance) |
| **Bob** | Account Holder | `bob` | `BobPassword123!` | Recipient customer account (\$500.00 initial balance) |
| **Admin** | Administrator | `admin` | `AdminPassword123!` | System operator; approves onboarding and views metrics |
| **Auditor** | Auditor | `auditor` | `AuditorPassword123!` | Read-only compliance; inspects ledger and audit trail |
| **Charlie** | Account Holder | `charlie` | `CharliePassword123!` | Unapproved user (`PENDING_APPROVAL`) to demonstrate onboarding |

> [!TIP]
> **One-Click Persona Switcher:** The top navigation bar in the web UI provides one-click buttons to instantly log in as any of these personas.

---

## 3. Step-by-Step Feature Walkthrough

### Scenario A: Concurrency Protection (100 Parallel Withdrawals)
1. In the Web UI, click the **100-Parallel Stress Test** tab.
2. Click **"Fire 100 Parallel Requests Now"**.
3. Watch 100 parallel requests fire simultaneously:
   - Exactly the permitted number of withdrawals succeed.
   - All subsequent withdrawals fail with `INSUFFICIENT_FUNDS`.
   - The final balance never drops below \$0.00.
   - The live conservation verification badge confirms the ledger remains 100% balanced!

### Scenario B: Cross-User Transfers & Idempotency Replay (FR-11, FR-15)
1. Log in as **Alice**.
2. Click **Transfer Money** — pick **Bob** from the privacy-preserving recipients dropdown (or enter Bob's `ACC-...` number directly) and submit.
3. Click **Deposit Funds** or **Transfer Money** again and notice the **"Idempotency Replay Ready"** card appears showing the exact `Idempotency-Key` UUID.
4. Click **"Replay Identical Request"** to verify the backend returns the cached response (`isCached: true`) without double-charging Alice's account!
5. Click **Export CSV** in the Account Statement card to download the reconciled ledger statement.

### Scenario C: User Onboarding, Admin Provisioning & Account Freeze (FR-6, FR-7, FR-9)
1. Try clicking the **Charlie (Pending)** persona button — notice the system rejects login (`ACCOUNT_PENDING_APPROVAL`).
2. Switch to **Admin** and open the **Administrator** tab.
3. Click **Approve / Activate** on Charlie (an initial `CHECKING` account is auto-provisioned). Switch back to **Charlie** — login now succeeds!
4. Under **All Customer Accounts (Freeze / Close Controls)**, click **Freeze** on an account to block debits/credits (`FROZEN`), or **Reset Demo DB** to restore initial balances cleanly while keeping append-only `audit_logs` intact.

### Scenario D: Double-Entry Ledger & Conservation (Auditor View)
1. Switch to the **Auditor** persona and open the **Auditor & Double-Entry Ledger** tab.
2. Review the live conservation cards: Total Debits, Total Credits, Clearing Vault Liability vs. Customer Equity, and Imbalance ($\Delta = \$0.00$).
3. Filter raw double-entry ledger lines by **Type** or **DEBIT/CREDIT** direction, and filter the **Immutable Audit Trail** by `SUCCESS`, `FAILURE`, or `UNAUTHORIZED`.

---

## 4. API Health, Documentation & Deployment

- **Health Check**: `GET http://localhost:8080/api/health` (public)
- **Readiness Check**: `GET http://localhost:8080/api/ready` (public)
- **System Conservation**: `GET http://localhost:8080/api/ledger/conservation` (Requires Bearer token)
- **REST API Reference**: [`docs/API.md`](./API.md)
- **Cloud & PostgreSQL Deployment Guide**: [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)

