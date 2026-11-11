// backend/src/services/accountService.js
const crypto = require('node:crypto');
const { withTransaction } = require('../db/database');
const config = require('../config');

class AccountService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Generate an account number: e.g. ACC-10029384
     */
    generateAccountNumber() {
        const randomDigits = Math.floor(10000000 + Math.random() * 90000000);
        return `ACC-${randomDigits}`;
    }

    /**
     * Create an account for a user.
     * FR-9: Account creation and balance management.
     */
    createAccount({ ownerId, accountType = 'CHECKING', currency = 'USD' }) {
        const user = this.db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(ownerId);
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }

        if (user.status !== 'ACTIVE' && user.id !== config.SYSTEM_USER_ID) {
            throw new Error('USER_NOT_ACTIVE');
        }

        const validTypes = ['CHECKING', 'SAVINGS', 'SYSTEM_CLEARING'];
        if (!validTypes.includes(accountType)) {
            throw new Error('INVALID_ACCOUNT_TYPE');
        }

        const accountId = 'acc_' + crypto.randomUUID();
        const accountNumber = this.generateAccountNumber();

        this.db.prepare(`
            INSERT INTO accounts (id, account_number, owner_id, account_type, currency, balance, status)
            VALUES (?, ?, ?, ?, ?, 0, 'ACTIVE')
        `).run(accountId, accountNumber, ownerId, accountType, currency);

        return this.getAccountById(accountId);
    }

    /**
     * Retrieve account by ID.
     */
    getAccountById(accountId) {
        const account = this.db.prepare(`
            SELECT a.id, a.account_number, a.owner_id, a.account_type, a.currency,
                   a.balance, a.status, a.version, a.created_at,
                   u.username as owner_username, u.email as owner_email
            FROM accounts a
            JOIN users u ON a.owner_id = u.id
            WHERE a.id = ?
        `).get(accountId);

        return account || null;
    }

    /**
     * Retrieve account by account number.
     */
    getAccountByNumber(accountNumber) {
        const account = this.db.prepare(`
            SELECT a.id, a.account_number, a.owner_id, a.account_type, a.currency,
                   a.balance, a.status, a.version, a.created_at,
                   u.username as owner_username, u.email as owner_email
            FROM accounts a
            JOIN users u ON a.owner_id = u.id
            WHERE a.account_number = ?
        `).get(accountNumber);

        return account || null;
    }

    /**
     * List all accounts for a user (or all accounts if admin/auditor).
     */
    getAccountsForUser(user) {
        if (user.role === 'ADMIN' || user.role === 'AUDITOR') {
            return this.db.prepare(`
                SELECT a.id, a.account_number, a.owner_id, a.account_type, a.currency,
                       a.balance, a.status, a.created_at,
                       u.username as owner_username, u.email as owner_email
                FROM accounts a
                JOIN users u ON a.owner_id = u.id
                ORDER BY a.created_at DESC
            `).all();
        }

        // FR-3: Account-level ownership checks
        return this.db.prepare(`
            SELECT a.id, a.account_number, a.owner_id, a.account_type, a.currency,
                   a.balance, a.status, a.created_at,
                   u.username as owner_username, u.email as owner_email
            FROM accounts a
            JOIN users u ON a.owner_id = u.id
            WHERE a.owner_id = ?
            ORDER BY a.created_at DESC
        `).all(user.userId);
    }

    /**
     * FR-20: Transaction statements per account.
     * Enforces FR-3: Account-level ownership check.
     */
    getAccountStatement(accountId, requestingUser) {
        const account = this.getAccountById(accountId);
        if (!account) {
            throw new Error('ACCOUNT_NOT_FOUND');
        }

        // FR-3: Account holder can only view their own account statements
        if (requestingUser.role === 'ACCOUNT_HOLDER' && account.owner_id !== requestingUser.userId) {
            throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
        }

        const entries = this.db.prepare(`
            SELECT le.id as entry_id, le.direction, le.amount, le.created_at,
                   t.id as transaction_id, t.type as transaction_type,
                   t.description, t.idempotency_key, t.created_by,
                   t.source_account_id, t.destination_account_id
            FROM ledger_entries le
            JOIN transactions t ON le.transaction_id = t.id
            WHERE le.account_id = ?
            ORDER BY le.created_at ASC
        `).all(accountId);

        // Compute running balance verification
        let calculatedBalance = 0;
        const entriesWithRunningBalance = entries.map(entry => {
            if (account.account_type === 'SYSTEM_CLEARING') {
                // For clearing account, DEBIT adds cash reserve, CREDIT releases
                if (entry.direction === 'DEBIT') calculatedBalance += entry.amount;
                else calculatedBalance -= entry.amount;
            } else {
                // For customer asset accounts: CREDIT increases balance (Deposit/Receive), DEBIT decreases balance (Withdraw/Send)
                if (entry.direction === 'CREDIT') calculatedBalance += entry.amount;
                else calculatedBalance -= entry.amount;
            }
            return {
                ...entry,
                running_balance: calculatedBalance
            };
        });

        return {
            account,
            current_balance: account.balance,
            calculated_balance: calculatedBalance,
            is_balance_consistent: calculatedBalance === account.balance,
            statement_entries: entriesWithRunningBalance
        };
    }
}

module.exports = { AccountService };
