# Evaluator & Demo Guide: LedgerLine / BalanceVault

**Event:** Snovasys Fresher Hiring Challenge 2026 (VVIT)  
**Author:** Harsha Gudipati ([@Harshagudipati](https://github.com/Harshagudipati))  
**Repository:** [https://github.com/Harshagudipati/ledgerline](https://github.com/Harshagudipati/ledgerline)

---

## 1. Quick Start (Zero Third-Party Dependency Installation Required)

This project is built using native Node.js (v20+ / v22+ / v24+) with zero external npm dependencies required for core database operations, cryptographic auth, transactions, and automated test execution.

### Step 1: Initialize Seed Data
```bash
node backend/src/db/seed.js
```

### Step 2: Run All 5 Automated Test Suites
```bash
node backend/tests/runTests.js
```
*Executes the 100-parallel-withdrawal concurrency test, idempotency validation, double-entry conservation, RBAC checks, and audit immutability triggers.*

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

### Scenario B: Idempotency Protection
1. Log in as Alice.
2. Click **Deposit Funds** or **Transfer Money**.
3. The request executes with an auto-generated `Idempotency-Key`.
4. Replaying the identical request with the same `Idempotency-Key` returns the original cached response without duplicate execution or double charges.

### Scenario C: User Onboarding Workflow (FR-6 & FR-7)
1. Try logging in as `charlie` / `CharliePassword123!`.
2. Notice the system rejects login with `ACCOUNT_PENDING_APPROVAL`.
3. Switch to the **Admin** persona and navigate to the **Administrator** tab.
4. Locate Charlie in the user table under `PENDING APPROVAL`.
5. Click **"Approve & Activate"**. An initial checking account is auto-provisioned!
6. Charlie can now log in immediately.

### Scenario D: Double-Entry Ledger & Conservation (Auditor View)
1. Switch to the **Auditor** persona and navigate to the **Auditor & Double-Entry Ledger** tab.
2. Review the live metrics: Total Debits, Total Credits, and Difference ($\Delta = \$0.00$).
3. Examine the raw double-entry ledger lines: every transaction has balanced DEBIT and CREDIT lines.
4. Scroll to the **Immutable Audit Trail**: notice every security, auth, and money action is indelibly recorded.

---

## 4. API Health & Operations Endpoints

- **Health Check**: `GET http://localhost:8080/api/health`
- **Readiness Check**: `GET http://localhost:8080/api/ready`
- **System Conservation**: `GET http://localhost:8080/api/ledger/conservation` (Requires Bearer token)

