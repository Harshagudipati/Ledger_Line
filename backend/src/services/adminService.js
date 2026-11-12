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

    async listUsers({ status = null, role = null } = {}) {
        let query = `
            SELECT id, username, email, role, status, failed_login_attempts, locked_until, created_at, updated_at
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

        query += ' ORDER BY created_at DESC';
        return this.db.all(query, ...params);
    }

    async createUser({ username, email, password, role = 'ACCOUNT_HOLDER' }, adminUser) {
        if (!username || !email || !password) {
            throw new Error('MISSING_FIELDS');
        }
        if (String(password).length < 8) {
            throw new Error('PASSWORD_TOO_SHORT');
        }
        const validRoles = ['ADMIN', 'ACCOUNT_HOLDER', 'AUDITOR'];
        if (!validRoles.includes(role)) {
            throw new Error('INVALID_ROLE');
        }

        const existing = await this.db.get(
            'SELECT id FROM users WHERE username = ? OR email = ?',
            username,
            email
        );
        if (existing) {
            throw new Error('USER_ALREADY_EXISTS');
        }

        const userId = 'usr_' + crypto.randomUUID();
        const { hash, salt } = hashPassword(password);

        await this.db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
        `, userId, username, email, hash, salt, role);

        let initialAccount = null;
        if (role === 'ACCOUNT_HOLDER' && this.accountService) {
            initialAccount = await this.accountService.createAccount({
                ownerId: userId,
                accountType: 'CHECKING',
                currency: 'USD'
            });
        }

        if (this.auditService && adminUser) {
            await this.auditService.record({
                actorId: adminUser.userId,
                actorUsername: adminUser.username,
                actorRole: adminUser.role,
                action: 'ADMIN_CREATED_USER',
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

    async activateUser(userId, adminUser) {
        const user = await this.db.get('SELECT id, username, email, role, status FROM users WHERE id = ?', userId);
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }

        await this.db.run(`
            UPDATE users
            SET status = 'ACTIVE', failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, userId);

        let initialAccount = null;
        if (user.role === 'ACCOUNT_HOLDER') {
            const existingAccounts = await this.db.all('SELECT id FROM accounts WHERE owner_id = ?', userId);
            if (existingAccounts.length === 0) {
                initialAccount = await this.accountService.createAccount({
                    ownerId: userId,
                    accountType: 'CHECKING',
                    currency: 'USD'
                });
            }
        }

        if (this.auditService) {
            await this.auditService.record({
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

    async deactivateUser(userId, adminUser) {
        const user = await this.db.get('SELECT id, username, email, role, status FROM users WHERE id = ?', userId);
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }
        if (user.id === adminUser.userId) {
            throw new Error('CANNOT_DEACTIVATE_OWN_ADMIN_ACCOUNT');
        }
        if (user.id === config.SYSTEM_USER_ID) {
            throw new Error('CANNOT_DEACTIVATE_SYSTEM_ROOT');
        }

        await this.db.run(`
            UPDATE users
            SET status = 'DEACTIVATED', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, userId);

        if (this.auditService) {
            await this.auditService.record({
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

    async getSystemStats() {
        const userStats = await this.db.get(`
            SELECT
                COUNT(*) as total_users,
                COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 ELSE 0 END), 0) as pending_users,
                COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END), 0) as active_users
            FROM users
            WHERE id != ?
        `, config.SYSTEM_USER_ID);

        const accountStats = await this.db.get(`
            SELECT
                COUNT(*) as total_accounts,
                COALESCE(SUM(balance), 0) as total_balances
            FROM accounts
            WHERE account_type != 'SYSTEM_CLEARING'
        `);

        const txStats = await this.db.get(`
            SELECT
                COUNT(*) as total_transactions,
                COALESCE(SUM(amount), 0) as total_volume
            FROM transactions
            WHERE status = 'COMPLETED'
        `);

        const auditStats = await this.db.get(`
            SELECT COUNT(*) as total_audit_entries FROM audit_logs
        `);

        return {
            users: {
                total_users: Number(userStats.total_users || 0),
                pending_users: Number(userStats.pending_users || 0),
                active_users: Number(userStats.active_users || 0)
            },
            accounts: {
                total_accounts: Number(accountStats.total_accounts || 0),
                total_balances: Number(accountStats.total_balances || 0)
            },
            transactions: {
                total_transactions: Number(txStats.total_transactions || 0),
                total_volume: Number(txStats.total_volume || 0)
            },
            audit: {
                total_audit_entries: Number(auditStats.total_audit_entries || 0)
            }
        };
    }
}

module.exports = { AdminService };
