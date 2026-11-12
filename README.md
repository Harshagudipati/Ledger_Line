# LedgerLine / BalanceVault

[![Double-Entry Invariance](https://img.shields.io/badge/Double--Entry-Zero--Sum%20Conserved-emerald?style=for-the-badge&logo=cashapp)](https://github.com/Harshagudipati/ledgerline)
[![Concurrency](https://img.shields.io/badge/Concurrency%20Test-100%20Parallel%20Safe-blue?style=for-the-badge&logo=lightning)](https://github.com/Harshagudipati/ledgerline)
[![Audit Immutability](https://img.shields.io/badge/Audit%20Trail-Append--Only%20Protected-indigo?style=for-the-badge&logo=shield)](https://github.com/Harshagudipati/ledgerline)
[![Tests](https://img.shields.io/badge/Automated%20Tests-6%2F6%20Passed-green?style=for-the-badge&logo=checkmarx)](https://github.com/Harshagudipati/ledgerline)

**Event:** Snovasys Fresher Hiring Challenge 2026 (VVIT)  
**Author:** Harsha Gudipati ([@Harshagudipati](https://github.com/Harshagudipati))  
**Repository:** [https://github.com/Harshagudipati/ledgerline](https://github.com/Harshagudipati/ledgerline)

---

## 📖 Executive Summary

**LedgerLine** is a money-movement system built around a mathematically provable, double-entry general ledger. Every financial transaction produces balanced debit and credit entries ($\sum \text{Debits} = \sum \text{Credits}$), preventing arbitrary balance inflation or phantom funds.

**BalanceVault** extends the core engine with enterprise account management:
- Multi-role Role-Based Access Control (**Administrator**, **Account Holder**, **Auditor**)
- Strict account-level ownership checks preventing cross-account theft
- User onboarding workflows (self-registration $\to$ administrator review $\to$ activation)
- Token-bucket rate limiting on sensitive routes
- Append-only, tamper-proof audit trail guarded by database triggers
- Idempotency middleware guaranteeing at-most-once execution for mutating requests
- Transactional row-level locking protecting against race conditions and negative balances under parallel load

---

## 🏛️ System Architecture

```
                            ┌────────────────────────────────┐
                            │    Modern Responsive Web UI    │
                            │  (Holder, Admin, Auditor Views)│
                            └───────────────┬────────────────┘
                                            │ HTTP (REST + JWT)
                                            ▼
                       ┌──────────────────────────────────────────┐
                       │           HTTP / API Engine              │
                       │  - Rate Limiter (Token Bucket)           │
                       │  - JWT Authentication & RBAC             │
                       │  - Idempotency Key Interceptor           │
                       └────────────────────┬─────────────────────┘
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              │                             │                             │
              ▼                             ▼                             ▼
   ┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
   │    Account Service   │      │    Ledger Engine     │      │    Audit Service     │
   │  - Ownership Checks  │      │  - Double-Entry D/C  │      │  - Append-Only Log   │
   │  - Account Lifecycles│      │  - Concurrency Lock  │      │  - Non-Repudiation   │
   └──────────┬───────────┘      └──────────┬───────────┘      └──────────┬───────────┘
              │                             │                             │
              └─────────────────────────────┼─────────────────────────────┘
                                            │
                                            ▼
                       ┌──────────────────────────────────────────┐
                       │          ACID Storage Layer              │
                       │  - BEGIN IMMEDIATE / Serialized Locks    │
                       │  - CHECK (balance >= 0) Constraint       │
                       │  - Immutability Database Triggers        │
                       └──────────────────────────────────────────┘
```

Detailed architectural diagrams and mathematical formulations can be found in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), REST endpoints in [docs/API.md](docs/API.md), and production deployment / PostgreSQL instructions in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## 🎯 Verification of PRD Section 11 Success Criteria

All claims specified in the Product Requirements Document are backed by automated tests:

| Claim / Success Criterion | Mechanism | Automated Test | Status |
|---|---|---|:---:|
| **100 Parallel Withdrawals never overdraw** | `BEGIN IMMEDIATE` / row-level transactional locking | [`backend/tests/concurrency.test.js`](backend/tests/concurrency.test.js) | ✅ **PASS** |
| **Replaying Idempotency Key never pays twice** | Idempotency registry + request parameter SHA-256 hash | [`backend/tests/idempotency.test.js`](backend/tests/idempotency.test.js) | ✅ **PASS** |
| **Ledger entries always sum to zero** | Balanced debit/credit double-entry assertion on each transaction | [`backend/tests/ledger.test.js`](backend/tests/ledger.test.js) | ✅ **PASS** |
| **Account Holder cannot access another holder's funds** | Enforced account-level ownership checks (`owner_id === user.id`) | [`backend/tests/security.test.js`](backend/tests/security.test.js) | ✅ **PASS** |
| **Audit entries cannot be modified or deleted** | SQLite `BEFORE UPDATE` & `BEFORE DELETE` triggers abort tampering | [`backend/tests/audit.test.js`](backend/tests/audit.test.js) | ✅ **PASS** |
| **End-to-End HTTP API, Freeze/Close & Rate Limits** | Full REST routing, header idempotency, account freeze & HTTP 429 | [`backend/tests/http.e2e.test.js`](backend/tests/http.e2e.test.js) | ✅ **PASS** |

---

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js**: v20+, v22+, or v24+ (zero third-party dependencies required!)

### 1. Clone & Seed Database
*(Optional — `server.js` also auto-seeds an empty database on first boot!)*
```bash
git clone https://github.com/Harshagudipati/ledgerline.git
cd ledgerline
node backend/src/db/seed.js
```

### 2. Run All Automated Test Suites
```bash
npm test
```

Output:
```
╔══════════════════════════════════════════════════════════════╗
║       LEDGERLINE / BALANCEVAULT AUTOMATED TEST SUITE        ║
║    Snovasys Fresher Hiring Challenge 2026 Verification       ║
╚══════════════════════════════════════════════════════════════╝

======================================================
 TEST SUITE 1: Concurrency Protection (100 Parallel Requests)
======================================================
⚡ Dispatching 100 simultaneous parallel withdrawals of $10...
Results: 10 Succeeded, 90 Failed (90 INSUFFICIENT_FUNDS)
Final account balance: $0
✓ PASS: Concurrency Protection prevents race conditions & negative balances!

======================================================
 TEST SUITE 2: Idempotency Protection
======================================================
✓ First transfer completed: Tx ID = tx_...
✓ Replay safely returned cached response. No second transaction created!
✓ Tampered payload with reused key successfully rejected: IDEMPOTENCY_KEY_PAYLOAD_MISMATCH
✓ PASS: Idempotency strictly guarantees at-most-once execution!

======================================================
 TEST SUITE 3: Double-Entry Ledger & Conservation
======================================================
✓ Every transaction in ledger has Debits = Credits (Zero-Sum Invariance)
✓ PASS: Double-Entry Ledger and System-Wide Conservation 100% verified!

======================================================
 TEST SUITE 4: Security, RBAC & Ownership Protection
======================================================
✓ Unauthorized cross-account withdrawal blocked: UNAUTHORIZED_ACCOUNT_ACCESS
✓ Charlie successfully activated with initial account ACC-...
✓ PASS: Security, RBAC & Ownership checks 100% verified!

======================================================
 TEST SUITE 5: Append-Only Audit Trail & Immutability
======================================================
✓ Database trigger successfully aborted UPDATE attempt
✓ Database trigger successfully aborted DELETE attempt
✓ PASS: Audit trail is provably immutable and tamper-proof!

======================================================
 TEST SUITE 6: End-to-End HTTP API, RBAC, Freeze & Rate Limit
======================================================
✓ 1. /api/health, /api/ready & auto-seed on empty DB verified
✓ 2. Public registration restricted to ACCOUNT_HOLDER + admin onboarding verified
✓ 3. Recipients privacy, Deposit replay, Account-number Transfer & Withdraw verified
✓ 4. FR-3 ownership enforcement + FR-9 FROZEN account blocking verified
✓ 5. RBAC/Failed-login audit records & audit-preserving reset-seed verified
✓ 6. HTTP 429 auth rate limit + Retry-After headers verified
✓ PASS: All HTTP End-to-End API, Security, Freeze & Rate Limit checks passed!

======================================================
 SUMMARY: 6 Passed, 0 Failed
======================================================
🎉 ALL 6 TEST SUITES PASSED! ALL SUCCESS CRITERIA MET.
```

### 3. Start Web Dashboard
```bash
node backend/src/server.js
```
Open **[http://localhost:8080](http://localhost:8080)** in your browser.

---

## 👥 Demo Personas

| Username | Password | Role | Description |
|---|---|---|---|
| `alice` | `AlicePassword123!` | `ACCOUNT_HOLDER` | Pre-funded with \$1,000.00 Checking Account |
| `bob` | `BobPassword123!` | `ACCOUNT_HOLDER` | Pre-funded with \$500.00 Checking Account |
| `admin` | `AdminPassword123!` | `ADMIN` | Platform operator; user management & onboarding |
| `auditor` | `AuditorPassword123!` | `AUDITOR` | Read-only compliance; inspects ledger and audit trail |
| `charlie` | `CharliePassword123!` | `ACCOUNT_HOLDER` | Starts in `PENDING_APPROVAL` to demo onboarding |

---

## 📂 Repository Structure

```
ledgerline/
├── PRD.md                         # Product Requirements Document
├── README.md                      # Primary project documentation & verification
├── Dockerfile                     # Production container definition (Node 24 LTS)
├── .dockerignore                  # Docker build exclusions
├── package.json                   # Project configuration & test scripts
├── .gitignore                     # Git ignore rules
├── docs/
│   ├── API.md                     # REST API endpoint specification
│   ├── ARCHITECTURE.md            # System architecture & math invariants
│   ├── DEMO_GUIDE.md              # Evaluator walkthrough guide
│   └── DEPLOYMENT.md              # Docker, Render, Railway, Fly.io & PostgreSQL guide
├── backend/
│   ├── src/
│   │   ├── config.js              # Application configuration
│   │   ├── server.js              # HTTP server & REST API router
│   │   ├── db/
│   │   │   ├── schema.sql         # SQLite DDL, constraints & triggers
│   │   │   ├── schema.postgres.sql# Production PostgreSQL DDL & PL/pgSQL triggers
│   │   │   ├── database.js        # SQLite connection & transaction management
│   │   │   └── seed.js            # Initial demo seed & audit-safe reset logic
│   │   ├── middleware/
│   │   │   ├── auth.js            # JWT verification & RBAC enforcement
│   │   │   └── rateLimiter.js     # Split auth/API token-bucket rate limiters
│   │   └── services/
│   │       ├── authService.js     # Password hashing, JWT tokens, bootstrap
│   │       ├── accountService.js  # Account creation, recipients, freeze/close, statements
│   │       ├── ledgerService.js   # Double-entry, idempotency, concurrency
│   │       ├── auditService.js    # Append-only audit trail
│   │       └── adminService.js    # User provisioning, approvals & stats
│   └── tests/
│       ├── concurrency.test.js    # 100 parallel withdrawals test
│       ├── idempotency.test.js    # Idempotency key replay test
│       ├── ledger.test.js         # Double-entry zero-sum & conservation test
│       ├── security.test.js       # Cross-account & RBAC security test
│       ├── audit.test.js          # Database trigger immutability test
│       ├── http.e2e.test.js       # End-to-end HTTP API, freeze & rate-limit test
│       └── runTests.js            # Master test runner
├── frontend/
│   ├── index.html                 # Single Page Application Dashboard
│   └── app.js                     # Client-side API integration & stress test widget
└── docs/
    ├── ARCHITECTURE.md            # In-depth architectural & mathematical proof
    └── DEMO_GUIDE.md              # Evaluator & judge step-by-step walkthrough
```

---

## 📜 License
This project is licensed under the MIT License.

