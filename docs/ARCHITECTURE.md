# System Architecture: LedgerLine / BalanceVault

**Event:** Snovasys Fresher Hiring Challenge 2026 (VVIT)  
**Author:** Harsha Gudipati ([@Harshagudipati](https://github.com/Harshagudipati))  
**Repository:** [https://github.com/Harshagudipati/ledgerline](https://github.com/Harshagudipati/ledgerline)

---

## 1. High-Level Architectural Overview

LedgerLine / BalanceVault is architected to guarantee mathematical correctness, non-repudiation, and transactional atomicity in money movement.

```
                          ┌────────────────────────────────┐
                          │   Frontend UI / Dashboard      │
                          │ (Holder, Admin, Auditor Views) │
                          └───────────────┬────────────────┘
                                          │ HTTP (REST + JWT)
                                          ▼
                     ┌──────────────────────────────────────────┐
                     │         Express / Node.js API            │
                     │  - Rate Limiter (Token Bucket)           │
                     │  - JWT Auth & RBAC Middleware            │
                     │  - Idempotency Interceptor               │
                     └────────────────────┬─────────────────────┘
                                          │
            ┌─────────────────────────────┼─────────────────────────────┐
            │                             │                             │
            ▼                             ▼                             ▼
 ┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
 │  Account Service     │      │   Ledger Service     │      │   Audit Service      │
 │  - Ownership Checks  │      │  - Double-Entry D/C  │      │  - Append-Only Log   │
 │  - Account Lifecycles│      │  - Concurrency Lock  │      │  - Non-Repudiation   │
 └──────────┬───────────┘      └──────────┬───────────┘      └──────────┬───────────┘
            │                             │                             │
            └─────────────────────────────┼─────────────────────────────┘
                                          │
                                          ▼
                     ┌──────────────────────────────────────────┐
                     │          ACID Relational Storage         │
                     │  - BEGIN IMMEDIATE / Row-level Locks     │
                     │  - CHECK (balance >= 0) Constraint       │
                     │  - Immutability Database Triggers        │
                     └──────────────────────────────────────────┘
```

---

## 2. Core Mathematical Invariants

### 2.1 Double-Entry Bookkeeping Invariance
Every transaction $T$ generates a set of ledger entries $E_T$. For any transaction $T$:

$$\sum_{e \in E_T, \, e.\text{direction}=\text{DEBIT}} e.\text{amount} = \sum_{e \in E_T, \, e.\text{direction}=\text{CREDIT}} e.\text{amount} = T.\text{amount}$$

Across the entire system at any point in time:

$$\sum_{\text{all entries}} \text{DEBITS} - \sum_{\text{all entries}} \text{CREDITS} = 0$$

### 2.2 System Conservation Invariance
The sum of all customer asset account balances matches the system clearing vault balance:

$$\sum_{a \in \text{Customer Accounts}} a.\text{balance} = \text{Balance}(\text{SYSTEM\_CLEARING})$$

### 2.3 Non-Negative Balance Invariance
For every customer account $a$:

$$a.\text{balance} \ge 0 \quad (\forall a, \forall t)$$

Enforced at two independent layers:
1. **Application Logic**: Checked within the serialized database transaction prior to balance mutation.
2. **Database Engine**: Enforced by hard constraint `CHECK(balance >= 0)`. Any attempt to overdraw causes an immediate rollback.

---

## 3. Concurrency Protection & Transaction Isolation

To prevent race conditions where parallel requests simultaneously read a balance and double-spend:
- **Locking Strategy**: Database transactions execute under exclusive write locks (`BEGIN IMMEDIATE` in SQLite / `SELECT ... FOR UPDATE` in PostgreSQL).
- **Serialization**: Concurrent requests against the same account are strictly serialized.
- **Stress-Test Verification**: When 100 concurrent requests of \$10 attempt to drain a \$100 account:
  - Exactly 10 requests succeed.
  - Exactly 90 requests fail with `INSUFFICIENT_FUNDS`.
  - The balance terminates at \$0.00 and never becomes negative.

---

## 4. Idempotency Guarantees

Every mutating request requires an `Idempotency-Key` HTTP header.

```
Request arrives with Key K and Payload P
           │
           ▼
 Does Key K exist in DB?
    ├── YES ──► Is Status COMPLETED?
    │                 ├── YES: Return cached StatusCode and Response (No Re-execution)
    │                 └── IN_PROGRESS: Reject concurrent request (409 Conflict)
    │
    └── NO ───► Insert Key with status IN_PROGRESS
                     │
                     ▼
             Execute Transaction
                     │
                     ▼
             Update Key status to COMPLETED with cached Response
```

---

## 5. Append-Only Audit Trail & Immutability

The `audit_logs` table stores an indelible record of all security and financial events.
Database triggers abort any direct SQL modifications:

```sql
CREATE TRIGGER prevent_audit_log_update
BEFORE UPDATE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'ILLEGAL_OPERATION: audit_logs is append-only and cannot be modified.');
END;

CREATE TRIGGER prevent_audit_log_delete
BEFORE DELETE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'ILLEGAL_OPERATION: audit_logs is append-only and cannot be deleted.');
END;
```

---

## 6. Role-Based Access Control (RBAC) Matrix

| Endpoint | Administrator | Account Holder | Auditor |
|---|:---:|:---:|:---:|
| `/api/auth/register` | Public | Public | Public |
| `/api/auth/login` | Yes | Yes | Yes |
| `/api/accounts` | All Accounts | Own Accounts Only | All (Read-Only) |
| `/api/accounts/:id/statement` | Yes | Own Account Only | Yes (Read-Only) |
| `/api/transactions/deposit` | Yes | Yes | No (403) |
| `/api/transactions/withdraw` | Yes | Yes (Own Account) | No (403) |
| `/api/transactions/transfer` | Yes | Yes (From Own) | No (403) |
| `/api/ledger/conservation` | Yes | Yes | Yes |
| `/api/ledger/entries` | Yes | No (403) | Yes (Read-Only) |
| `/api/audit/logs` | Yes | No (403) | Yes (Read-Only) |
| `/api/admin/*` | Yes | No (403) | No (403) |

