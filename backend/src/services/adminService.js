// backend/src/services/adminService.js
const crypto = require('node:crypto');
const config = require('../config');
const { hashPassword } = require('./authService');

class AdminService {
    constructor(db, auditService, accountService) {
        this.db = db;
        this.auditService = auditService;
        this.accountService = accountService;
    }

    /**
     * FR-8: List all platform users with filtering (excludes internal system root user).
     */
    listUsers({ status = null, role = null } = {}) {
        let query = `
            SELECT id, username, email, role, status, created_at, updated_at
            FROM users
            WHERE id != ?
        `;
        const params = [config.SYSTEM_USER_ID];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }
        if (role) {
            query += ' AND role = ?';
            params.push(role);
        }

        query += ' ORDER BY created_at DESC, rowid DESC';
        return this.db.prepare(query).all(...params);
    }

    /**
     * FR-8: Admin directly creates an active user (Account Holder, Auditor, or Admin).
     */
    createUser({ username, email, password, role = 'ACCOUNT_HOLDER' }, adminUser) {
        if (!username || !email || !password) {
            throw new Error('MISSING_FIELDS');
        }
        if (typeof password !== 'string' || password.length < 8) {
            throw new Error('PASSWORD_TOO_SHORT');
        }
        const validRoles = ['ACCOUNT_HOLDER', 'AUDITOR', 'ADMIN'];
        if (!validRoles.includes(role)) {
            throw new Error('INVALID_ROLE');
        }

        const existing = this.db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
        if (existing) {
            throw new Error('USER_ALREADY_EXISTS');
        }

        const userId = 'usr_' + crypto.randomUUID();
        const { hash, salt } = hashPassword(password);

        this.db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
        `).run(userId, username, email, hash, salt, role);

        let initialAccount = null;
        if (role === 'ACCOUNT_HOLDER') {
            initialAccount = this.accountService.createAccount({
                ownerId: userId,
                accountType: 'CHECKING',
                currency: 'USD'
            });
        }

        if (this.auditService && adminUser) {
            this.auditService.record({
                actorId: adminUser.userId,
                actorUsername: adminUser.username,
                actorRole: adminUser.role,
                action: 'USER_CREATED_BY_ADMIN',
                entityType: 'USER',
                entityId: userId,
                details: { username, email, role, initialAccountId: initialAccount?.id || null },
                status: 'SUCCESS'
            });
        }

        return {
            id: userId,
            username,
            email,
            role,
            status: 'ACTIVE',
            initialAccount
        };
    }

    /**
     * FR-7: Approve and activate a pending user onboarding request.
     * When an account holder is activated, also provision their initial primary Checking account!
     */
    activateUser(userId, adminUser) {
        const user = this.db.prepare('SELECT id, username, email, role, status FROM users WHERE id = ?').get(userId);
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }

        this.db.prepare(`
            UPDATE users
            SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(userId);

        // If the activated user is an ACCOUNT_HOLDER and has no accounts yet, provision their initial checking account!
        let initialAccount = null;
        if (user.role === 'ACCOUNT_HOLDER') {
            const existingAccounts = this.db.prepare('SELECT id FROM accounts WHERE owner_id = ?').all(userId);
            if (existingAccounts.length === 0) {
                initialAccount = this.accountService.createAccount({
                    ownerId: userId,
                    accountType: 'CHECKING',
                    currency: 'USD'
                });
            }
        }

        if (this.auditService) {
            this.auditService.record({
                actorId: adminUser.userId,
                actorUsername: adminUser.username,
                actorRole: adminUser.role,
                action: 'USER_ACTIVATED',
                entityType: 'USER',
                entityId: userId,
                details: { targetUsername: user.username, role: user.role, initialAccountId: initialAccount?.id },
                status: 'SUCCESS'
            });
        }

        return {
            id: user.id,
            username: user.username,
            status: 'ACTIVE',
            initialAccount
        };
    }

    /**
     * Deactivate a user.
     */
    deactivateUser(userId, adminUser) {
        const user = this.db.prepare('SELECT id, username, email, role, status FROM users WHERE id = ?').get(userId);
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }
        if (user.id === adminUser.userId) {
            throw new Error('CANNOT_DEACTIVATE_OWN_ADMIN_ACCOUNT');
        }
        if (user.id === config.SYSTEM_USER_ID) {
            throw new Error('CANNOT_DEACTIVATE_SYSTEM_ROOT');
        }

        this.db.prepare(`
            UPDATE users
            SET status = 'DEACTIVATED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(userId);

        if (this.auditService) {
            this.auditService.record({
                actorId: adminUser.userId,
                actorUsername: adminUser.username,
                actorRole: adminUser.role,
                action: 'USER_DEACTIVATED',
                entityType: 'USER',
                entityId: userId,
                details: { targetUsername: user.username, role: user.role },
                status: 'SUCCESS'
            });
        }

        return {
            id: user.id,
            username: user.username,
            status: 'DEACTIVATED'
        };
    }

    /**
     * System-wide overview statistics.
     */
    getSystemStats() {
        const userStats = this.db.prepare(`
            SELECT 
                COUNT(*) as total_users,
                SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 ELSE 0 END) as pending_users,
                SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_users
            FROM users
            WHERE id != ?
        `).get(config.SYSTEM_USER_ID);

        const accountStats = this.db.prepare(`
            SELECT 
                COUNT(*) as total_accounts,
                COALESCE(SUM(balance), 0) as total_balances
            FROM accounts
            WHERE account_type != 'SYSTEM_CLEARING'
        `).get();

        const txStats = this.db.prepare(`
            SELECT 
                COUNT(*) as total_transactions,
                COALESCE(SUM(amount), 0) as total_volume
            FROM transactions
            WHERE status = 'COMPLETED'
        `).get();

        const auditStats = this.db.prepare(`
            SELECT COUNT(*) as total_audit_entries FROM audit_logs
        `).get();

        return {
            users: userStats,
            accounts: accountStats,
            transactions: txStats,
            audit: auditStats
        };
    }
}

module.exports = { AdminService };
