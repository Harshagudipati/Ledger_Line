# Product Requirements Document: LedgerLine / BalanceVault

**Event:** Snovasys Fresher Hiring Challenge 2026 (VVIT), Nov 6-12, 2026  
**Repository:** https://github.com/sivaLingaiah/ledgerline  
**Status:** In development (hackathon demo, synthetic data only)

> **Note on the source material:** The two documents describe different stacks. LedgerLine uses Java 21, Spring Boot, Maven and React/Vite. BalanceVault, the extension, uses Node.js, Prisma, Redis and a deployed React frontend. This PRD treats LedgerLine as the core money-movement product and BalanceVault as the extension for account management and access control. The stack decision is addressed in Section 9.

---

## 1. Overview

### 1.1 Product Summary
LedgerLine is a money-movement system with a ledger that can be proven correct. Every transaction must be accurate, authorised, traceable and recorded in a reliable ledger. BalanceVault extends it with secure account management: role-based access, user onboarding and auditable operations.

### 1.2 Problem Statement
Financial applications are unsafe when they allow:
- Duplicate requests that pay twice
- Simultaneous withdrawals that overdraw an account
- Unauthorised transactions
- Incorrect account balances

Storing account data is not enough. Systems also need controlled access, secure authentication, clear onboarding and accountability for every important action.

### 1.3 Goals
1. Money movement keeps the books balanced at all times.
2. The same request never executes twice (idempotency).
3. Concurrent operations cannot corrupt balances.
4. Every action is authorised by role and account ownership.
5. Every action is recorded in an append-only audit trail.
6. Each claim is backed by automated tests and a demo.

### 1.4 Non-Goals
- Production financial service or handling of real funds
- Real payment-rail or bank integrations
- Regulatory compliance (KYC/AML, PCI)

---

## 2. Users and Roles

| Role | Description | Key Permissions |
|---|---|---|
| **Administrator** | Platform operator | Manage users, approve onboarding, view audit logs |
| **Account Holder** | End user with one or more accounts | View own accounts, deposit, withdraw, transfer, view statements |
| **Auditor** | Read-only compliance user | View ledger, transactions and audit trail; no mutations |

---

## 3. Functional Requirements

### 3.1 Authentication and Authorisation
- **FR-1:** Secure login for administrators, account holders and auditors.
- **FR-2:** Role-based access control on every endpoint.
- **FR-3:** Account-level ownership checks. A holder can only access their own accounts.
- **FR-4:** First-admin bootstrap process, with a restricted database role for the bootstrap function.
- **FR-5:** Backend rate limiting (Redis) on sensitive routes.

### 3.2 Onboarding and User Management
- **FR-6:** Account-holder self-registration.
- **FR-7:** Account onboarding workflow (request, admin review, activation).
- **FR-8:** Admin user management (view, activate, deactivate).

### 3.3 Accounts
- **FR-9:** Account creation and balance management.
- **FR-10:** The server prevents negative balances.

### 3.4 Money Movement
- **FR-11:** Deposits.
- **FR-12:** Withdrawals.
- **FR-13:** Transfers between accounts.
- **FR-14:** Double-entry ledger. Each transaction produces balanced debit and credit entries.
- **FR-15:** Money-conservation checks. Total debits equal total credits, and the sum of balances is consistent with the ledger.

### 3.5 Idempotency
- **FR-16:** Each mutating request carries an idempotency key.
- **FR-17:** A repeated key returns the original result and never executes a second time.

### 3.6 Concurrency Protection
- **FR-18:** Database transactions with locking or an appropriate isolation level, so simultaneous withdrawals or transfers cannot overdraw or double-spend.

### 3.7 Audit and Statements
- **FR-19:** Append-only audit trail of important actions (who, what, when, outcome).
- **FR-20:** Transaction statements per account.
- **FR-21:** Admin and auditor access to audit logs.

### 3.8 Frontend
- **FR-22:** React dashboard for each role, integrated with the API.

### 3.9 Operations
- **FR-23:** Health and readiness endpoints (`/api/health`).
- **FR-24:** Database migrations (Flyway for the Java stack, Prisma for the Node stack) with separate DB roles for different responsibilities.

---

## 4. Non-Functional Requirements

| Category | Requirement |
|---|---|
| **Correctness** | Balances never go negative. Ledger entries always sum to zero. |
| **Security** | No secrets in the repo. Credentials come from environment variables. Least-privilege DB roles. |
| **Reliability** | Operations are atomic. Retries are safe. |
| **Auditability** | Audit records cannot be updated or deleted. |
| **Testability** | Automated tests cover security, concurrency and transaction logic. |
| **Operability** | Deployed demo with health and readiness checks and basic monitoring. |

---

## 5. Technical Architecture

### 5.1 Current Stack
| Layer | LedgerLine (initial setup) | BalanceVault (extension) |
|---|---|---|
| Frontend | React + Vite (port 5173) | React, deployed |
| Backend | Java 21, Spring Boot, Spring Security, Maven (port 8080) | Node.js API routes |
| Database | PostgreSQL (`ledgerline_db`) | PostgreSQL via Prisma, hosted on Neon |
| Other | Flyway migrations | Redis rate limiting, separate DB roles |

### 5.2 Data Model (proposed)
- `users` (id, credentials, role, status)
- `accounts` (id, owner_id, balance, status)
- `transactions` (id, type, idempotency_key, status, created_at)
- `ledger_entries` (id, transaction_id, account_id, direction, amount)
- `audit_log` (id, actor_id, action, entity, details, created_at), append-only

---

## 6. Setup and Run Instructions

**Prerequisites:** Java 21, Maven, Node.js, npm, PostgreSQL

1. Ensure PostgreSQL is running and `ledgerline_db` exists.
2. **Backend (Windows CMD):**
   ```bash
   cd /d "%USERPROFILE%\Desktop\LegderLine\backend\ledgerline"
   set "DB_PASSWORD=YOUR_DATABASE_PASSWORD"
   mvnw.cmd spring-boot:run
   ```
   Backend: http://localhost:8080, health: http://localhost:8080/api/health
3. **Frontend (second CMD window):**
   ```bash
   cd /d "%USERPROFILE%\Desktop\LegderLine\frontend"
   npm install
   npm run dev
   ```
   Frontend: http://localhost:5173/

**BalanceVault:** run `npm run db:generate`, then `npm run db:migrate`. Start the workspaces with the root `package.json` scripts. The frontend and backend must point at local Postgres and Redis instances.

---

## 7. Current Status

### Completed
- React/Vite frontend scaffold
- Java 21 and Spring Boot backend scaffold
- PostgreSQL and application user configured
- Spring Security configuration started
- Health-check endpoint
- (BalanceVault) Deployed frontend, Node backend, Prisma and migrations, DB roles, auth and RBAC implementation, registration and onboarding workflows, Redis rate limiting, health and readiness endpoints

### Not Finished
1. Admin, account-holder and auditor authentication and full RBAC
2. Account creation and balance management
3. Deposits, withdrawals and transfers
4. Double-entry ledger and money-conservation checks
5. Server-side negative-balance prevention
6. Idempotency
7. Transaction and concurrency protection
8. Append-only audit trail and statements
9. Account-level ownership checks
10. Automated security, concurrency and transaction tests
11. Complete React dashboard and API integration
12. Deployment, API documentation, seed accounts and demo video
13. First-admin bootstrap and admin login verified on the live deployment
14. End-to-end registration and onboarding tests
15. Verification of admin user management and audit logs through the live UI
16. Deployment monitoring improvements

---

## 8. Known Issues and Lessons Learned

**LedgerLine setup**
- Maven specified Java 25 but the installed JDK was 21, so the version was corrected to 21.
- An unresolvable governance starter dependency was removed.
- The Flyway dependency caused Maven version-management problems, and the configuration was fixed.
- PostgreSQL authentication failed until the user password was reset and passed via an environment variable.

**BalanceVault deployment**
- AI confused PostgreSQL role membership with permission to administer another role. Neon rejected the password change with SQLSTATE 42501.
- Root cause analysis covered the bootstrap login, its membership in the bootstrap operator role, `SET ROLE` permission, and execute permission on the bootstrap function.
- **Lesson:** AI suggestions must be verified against the real environment. Inspect actual configuration instead of granting broader privileges.

**AI tools used:** ChatGPT (planning, configuration, debugging, Git guidance) and OpenAI Codex in VS Code (implementation, repo inspection, code review).

---

## 9. Open Questions and Risks

| # | Item |
|---|---|
| 1 | **Stack decision:** keep the Java/Spring Boot backend or consolidate on Node/Prisma? Maintaining both splits effort within a 7-day window. |
| 2 | The first-admin bootstrap is not yet verified on the live deployment. |
| 3 | The repo path contains the typo `LegderLine`. Consider renaming it for consistency. |
| 4 | Time risk: core money-integrity features (ledger, idempotency, concurrency) are the highest value and are still unbuilt. |

---

## 10. Milestones and Priorities

| Priority | Milestone | Deliverables |
|---|---|---|
| **P0** | Core integrity | Accounts, double-entry ledger, deposit/withdraw/transfer, no negative balances |
| **P0** | Safety | Idempotency keys, transactional concurrency control |
| **P0** | Access | Auth for 3 roles, RBAC, ownership checks |
| **P1** | Accountability | Append-only audit trail, statements |
| **P1** | Tests | Concurrency (parallel withdrawals), idempotency (duplicate requests), security (unauthorised access) |
| **P2** | Experience | Complete React dashboard |
| **P2** | Delivery | Deployment, API docs, seed accounts, demo video |

---

## 11. Success Criteria

- 100 parallel withdrawals against one account never produce a negative balance.
- Replaying the same idempotency key never creates a second transaction.
- The ledger sums to zero after any sequence of operations.
- An account holder cannot read or modify another holder's account.
- Audit entries cannot be modified or deleted.
- All claims are verified by automated tests before being marked complete.

