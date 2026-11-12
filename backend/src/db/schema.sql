-- ============================================================================
-- LedgerLine / BalanceVault Database Schema (SQLite)
-- Multi-Role, Double-Entry Accounting, Idempotent, Append-Only Audit Trail
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 0. Schema Migrations Tracking Table
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 1. Users Table (Admin, Account Holder, Auditor)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR')),
    status TEXT NOT NULL CHECK(status IN ('PENDING_APPROVAL', 'ACTIVE', 'DEACTIVATED')) DEFAULT 'PENDING_APPROVAL',
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Revoked JWT Tokens Table (Server-Side Logout / Session Invalidation)
CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Accounts Table
CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    account_number TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    account_type TEXT NOT NULL CHECK(account_type IN ('CHECKING', 'SAVINGS', 'SYSTEM_CLEARING')),
    currency TEXT NOT NULL DEFAULT 'USD',
    balance INTEGER NOT NULL CHECK(balance >= 0) DEFAULT 0, -- Stored in cents (integer) to avoid float rounding errors
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'FROZEN', 'CLOSED')) DEFAULT 'ACTIVE',
    version INTEGER NOT NULL DEFAULT 1, -- Optimistic concurrency control counter
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Transactions Table
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER')),
    idempotency_key TEXT UNIQUE NOT NULL,
    source_account_id TEXT REFERENCES accounts(id),
    destination_account_id TEXT REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL CHECK(status IN ('COMPLETED', 'FAILED', 'REJECTED')),
    description TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Double-Entry Ledger Entries Table
CREATE TABLE IF NOT EXISTS ledger_entries (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    direction TEXT NOT NULL CHECK(direction IN ('DEBIT', 'CREDIT')),
    amount INTEGER NOT NULL CHECK(amount > 0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Idempotency Keys Registry Table
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    request_path TEXT NOT NULL,
    request_params_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
    response_code INTEGER,
    response_body TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);

-- 7. Append-Only Audit Trail Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    actor_username TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details TEXT,
    ip_address TEXT,
    status TEXT NOT NULL CHECK(status IN ('SUCCESS', 'FAILURE', 'UNAUTHORIZED')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Database Triggers to enforce Append-Only Immutability on audit_logs
CREATE TRIGGER IF NOT EXISTS prevent_audit_log_update
BEFORE UPDATE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'ILLEGAL_OPERATION: audit_logs is append-only and cannot be modified.');
END;

CREATE TRIGGER IF NOT EXISTS prevent_audit_log_delete
BEFORE DELETE ON audit_logs
BEGIN
    SELECT RAISE(ABORT, 'ILLEGAL_OPERATION: audit_logs is append-only and cannot be deleted.');
END;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_revoked_expires ON revoked_tokens(expires_at);
