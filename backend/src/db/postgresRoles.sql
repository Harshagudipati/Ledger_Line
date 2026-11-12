-- ============================================================================
-- LedgerLine / BalanceVault Least-Privilege PostgreSQL Roles (FR-4, FR-24)
-- ============================================================================
-- Run as PostgreSQL superuser/owner after applying schema.postgres.sql.
-- Separates runtime application permissions, read-only auditor queries, and
-- restricted first-admin bootstrap execution.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledgerline_app') THEN
        CREATE ROLE ledgerline_app NOINHERIT LOGIN PASSWORD 'CHANGE_ME_APP_PASSWORD';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledgerline_auditor') THEN
        CREATE ROLE ledgerline_auditor NOINHERIT LOGIN PASSWORD 'CHANGE_ME_AUDITOR_PASSWORD';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledgerline_bootstrap') THEN
        CREATE ROLE ledgerline_bootstrap NOINHERIT LOGIN PASSWORD 'CHANGE_ME_BOOTSTRAP_PASSWORD';
    END IF;
END $$;

-- 1. Operational App Role: Full transactional access EXCEPT updating/deleting audit_logs or ledger_entries
GRANT SELECT, INSERT, UPDATE, DELETE ON users, revoked_tokens, accounts, idempotency_keys TO ledgerline_app;
GRANT SELECT, INSERT ON transactions, ledger_entries, audit_logs TO ledgerline_app;
REVOKE UPDATE, DELETE ON ledger_entries, audit_logs FROM ledgerline_app;

-- 2. Auditor Role: Strictly read-only across ledger, transactions, accounts, and audit logs
GRANT SELECT ON accounts, transactions, ledger_entries, audit_logs TO ledgerline_auditor;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM ledgerline_auditor;

-- 3. Bootstrap Role (FR-4): Restricted function/table privilege for first-admin creation only
CREATE OR REPLACE FUNCTION bootstrap_first_admin(
    p_id TEXT,
    p_username TEXT,
    p_email TEXT,
    p_password_hash TEXT,
    p_password_salt TEXT
) RETURNS TEXT
SECURITY DEFINER
AS $$
DECLARE
    v_admin_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_admin_count FROM users WHERE role = 'ADMIN' AND id != 'usr_system_root';
    IF v_admin_count > 0 THEN
        RAISE EXCEPTION 'ADMIN_ALREADY_BOOTSTRAPPED';
    END IF;

    INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
    VALUES (p_id, p_username, p_email, p_password_hash, p_password_salt, 'ADMIN', 'ACTIVE');

    INSERT INTO audit_logs (id, actor_id, actor_username, actor_role, action, entity_type, entity_id, status)
    VALUES ('aud_' || gen_random_uuid()::TEXT, p_id, p_username, 'ADMIN', 'ADMIN_BOOTSTRAPPED', 'USER', p_id, 'SUCCESS');

    RETURN p_id;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION bootstrap_first_admin(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_first_admin(TEXT, TEXT, TEXT, TEXT, TEXT) TO ledgerline_bootstrap;
