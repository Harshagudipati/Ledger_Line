// backend/src/services/accountService.js
const crypto = require('node:crypto');
const config = require('../config');

class AccountService {
    constructor(db, auditService) {
        this.db = db;
        this.auditService = auditService;
    }

    generateAccountNumber() {
        const randomNum = crypto.randomInt(10000000, 99999999);
        return `ACC-${randomNum}`;
    }

    async createAccount({ ownerId, accountType = 'CHECKING', currency = 'USD', allowSystemClearing = false }) {
        if (!ownerId) {
            throw new Error('OWNER_ID_REQUIRED');
        }
        const validTypes = allowSystemClearing ? ['CHECKING', 'SAVINGS', 'SYSTEM_CLEARING'] : ['CHECKING', 'SAVINGS'];
        if (!validTypes.includes(accountType)) {
            throw new Error('INVALID_ACCOUNT_TYPE');
        }
        const normalizedCurrency = String(currency || 'USD').trim().toUpperCase();
        if (!['USD'].includes(normalizedCurrency)) {
            throw new Error('INVALID_CURRENCY');
        }
        const owner = await this.db.get('SELECT id, status FROM users WHERE id = ?', ownerId);
        if (!owner) {
            throw new Error('USER_NOT_FOUND');
        }
        if (owner.status !== 'ACTIVE' && accountType !== 'SYSTEM_CLEARING') {
            throw new Error('USER_NOT_ACTIVE');
        }

        const id = accountType === 'SYSTEM_CLEARING'
            ? config.SYSTEM_CLEARING_ACCOUNT_ID
            : 'acc_' + crypto.randomUUID();
        const accountNumber = accountType === 'SYSTEM_CLEARING'
            ? 'SYS-CLEARING-000'
            : this.generateAccountNumber();

        await this.db.run(`
            INSERT INTO accounts (id, account_number, owner_id, account_type, currency, balance, status)
            VALUES (?, ?, ?, ?, ?, 0, 'ACTIVE')
        `, id, accountNumber, ownerId, accountType, normalizedCurrency);

        const account = await this.getAccountById(id);

        if (this.auditService) {
            await this.auditService.record({
                actorId: ownerId,
                action: 'ACCOUNT_CREATED',
                entityType: 'ACCOUNT',
                entityId: id,
                details: { accountNumber, accountType, currency },
                status: 'SUCCESS'
            });
        }

        return account;
    }

    async getAccountById(accountId) {
        const row = await this.db.get(`
            SELECT a.*, u.username as owner_username, u.email as owner_email
            FROM accounts a
            JOIN users u ON a.owner_id = u.id
            WHERE a.id = ?
        `, accountId);
        if (!row) return undefined;
        return { ...row, balance: Number(row.balance), version: Number(row.version) };
    }

    async getAccountsForUser(user) {
        if (user.role === 'ADMIN' || user.role === 'AUDITOR') {
            const rows = await this.db.all(`
                SELECT a.id, a.account_number, a.owner_id, a.account_type, a.currency,
                       a.balance, a.status, a.created_at,
                       u.username as owner_username, u.email as owner_email
                FROM accounts a
                JOIN users u ON a.owner_id = u.id
                ORDER BY ${this.db.orderByInsertion('a', 'DESC')}
            `);
            return rows.map(r => ({ ...r, balance: Number(r.balance) }));
        }

        const rows = await this.db.all(`
            SELECT a.id, a.account_number, a.owner_id, a.account_type, a.currency,
                   a.balance, a.status, a.created_at,
                   u.username as owner_username, u.email as owner_email
            FROM accounts a
            JOIN users u ON a.owner_id = u.id
            WHERE a.owner_id = ?
            ORDER BY ${this.db.orderByInsertion('a', 'DESC')}
        `, user.userId);
        return rows.map(r => ({ ...r, balance: Number(r.balance) }));
    }

    /**
     * List active customer accounts as safe transfer recipients (FR-3 privacy).
     */
    async listTransferRecipients(excludeAccountId = null) {
        let query = `
            SELECT a.id, a.account_number, a.account_type, a.currency, u.username as owner_username
            FROM accounts a
            JOIN users u ON a.owner_id = u.id
            WHERE a.account_type != 'SYSTEM_CLEARING'
              AND a.status = 'ACTIVE'
              AND u.status = 'ACTIVE'
        `;
        const params = [];
        if (excludeAccountId) {
            query += ' AND a.id != ?';
            params.push(excludeAccountId);
        }
        query += ' ORDER BY u.username ASC, a.created_at ASC';
        return this.db.all(query, ...params);
    }

    /**
     * FR-9: Admin account status management (ACTIVE, FROZEN, CLOSED).
     */
    async updateAccountStatus(accountId, newStatus, adminUser) {
        const validStatuses = ['ACTIVE', 'FROZEN', 'CLOSED'];
        if (!validStatuses.includes(newStatus)) {
            throw new Error('INVALID_ACCOUNT_STATUS');
        }

        const account = await this.getAccountById(accountId);
        if (!account) {
            throw new Error('ACCOUNT_NOT_FOUND');
        }
        if (account.account_type === 'SYSTEM_CLEARING') {
            throw new Error('CANNOT_MODIFY_SYSTEM_CLEARING_ACCOUNT');
        }
        if (newStatus === 'CLOSED' && account.balance > 0) {
            throw new Error('CANNOT_CLOSE_ACCOUNT_WITH_NONZERO_BALANCE');
        }

        await this.db.run(`
            UPDATE accounts
            SET status = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, newStatus, accountId);

        if (this.auditService && adminUser) {
            await this.auditService.record({
                actorId: adminUser.userId,
                actorUsername: adminUser.username,
                actorRole: adminUser.role,
                action: `ACCOUNT_STATUS_CHANGED_${newStatus}`,
                entityType: 'ACCOUNT',
                entityId: accountId,
                details: { accountNumber: account.account_number, previousStatus: account.status, newStatus },
                status: 'SUCCESS'
            });
        }

        return this.getAccountById(accountId);
    }

    /**
     * Close an owner's (or admin's) account; if balance > 0, sweep remaining funds atomically
     * to a chosen active destination account via double-entry ledger before marking CLOSED.
     */
    async closeAccountWithSweep({ accountId, destinationAccountId = null, destinationAccountNumber = null, actor }) {
        if (!accountId || !actor) {
            throw new Error('MISSING_REQUIRED_PARAMETERS');
        }

        return this.db.withTransaction(async (txDb) => {
            // Lock source account immediately so concurrent PG transactions cannot alter balance before closure
            await txDb.lockAccountsForUpdate([accountId]);

            const target = await txDb.get('SELECT * FROM accounts WHERE id = ?', accountId);
            if (!target) {
                throw new Error('ACCOUNT_NOT_FOUND');
            }
            if (target.account_type === 'SYSTEM_CLEARING') {
                throw new Error('CANNOT_MODIFY_SYSTEM_CLEARING_ACCOUNT');
            }
            if (actor.role === 'ACCOUNT_HOLDER' && target.owner_id !== actor.userId) {
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }
            if (target.status === 'CLOSED') {
                throw new Error('ACCOUNT_ALREADY_CLOSED');
            }
            if (target.status !== 'ACTIVE' && Number(target.balance) > 0) {
                throw new Error('ACCOUNT_NOT_ACTIVE');
            }

            const currentBalance = Number(target.balance);
            let sweepTransactionId = null;

            if (currentBalance > 0) {
                let dest = null;
                if (destinationAccountId) {
                    dest = await txDb.get('SELECT * FROM accounts WHERE id = ?', destinationAccountId);
                } else if (destinationAccountNumber) {
                    dest = await txDb.get('SELECT * FROM accounts WHERE account_number = ?', destinationAccountNumber.trim());
                } else {
                    throw new Error('SWEEP_DESTINATION_REQUIRED');
                }

                if (!dest) {
                    throw new Error('DESTINATION_ACCOUNT_NOT_FOUND');
                }
                if (dest.id === target.id) {
                    throw new Error('CANNOT_TRANSFER_TO_SAME_ACCOUNT');
                }
                if (dest.status !== 'ACTIVE' || dest.account_type === 'SYSTEM_CLEARING') {
                    throw new Error('ACCOUNT_NOT_ACTIVE');
                }

                // Deterministic lock ordering across both accounts
                await txDb.lockAccountsForUpdate([target.id, dest.id]);

                const lockedSource = await txDb.get('SELECT balance, status FROM accounts WHERE id = ?', target.id);
                const lockedDest = await txDb.get('SELECT balance, status FROM accounts WHERE id = ?', dest.id);
                if (!lockedDest || lockedDest.status !== 'ACTIVE') {
                    throw new Error('ACCOUNT_NOT_ACTIVE');
                }

                const sweepAmount = Number(lockedSource.balance);
                const destBal = Number(lockedDest.balance);
                if (!Number.isSafeInteger(destBal + sweepAmount) || destBal + sweepAmount > 1_000_000_000_000_00) {
                    throw new Error('BALANCE_LIMIT_EXCEEDED');
                }
                if (sweepAmount > 0) {
                    sweepTransactionId = 'tx_' + crypto.randomUUID();
                    const idemKey = `close-sweep-${target.id}-${crypto.randomUUID()}`;

                    await txDb.run(
                        'UPDATE accounts SET balance = balance - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        sweepAmount, target.id
                    );
                    await txDb.run(
                        'UPDATE accounts SET balance = balance + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        sweepAmount, dest.id
                    );

                    await txDb.run(`
                        INSERT INTO transactions (id, type, idempotency_key, source_account_id, destination_account_id, amount, status, description, created_by)
                        VALUES (?, 'TRANSFER', ?, ?, ?, ?, 'COMPLETED', ?, ?)
                    `, sweepTransactionId, idemKey, target.id, dest.id, sweepAmount, `Balance sweep on closure of ${target.account_number}`, actor.userId);

                    await txDb.run(
                        `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'DEBIT', ?)`,
                        'le_' + crypto.randomUUID(), sweepTransactionId, target.id, sweepAmount
                    );
                    await txDb.run(
                        `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'CREDIT', ?)`,
                        'le_' + crypto.randomUUID(), sweepTransactionId, dest.id, sweepAmount
                    );
                }
            }

            await txDb.run(`
                UPDATE accounts
                SET status = 'CLOSED', version = version + 1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, target.id);

            const closedAccount = await txDb.get('SELECT * FROM accounts WHERE id = ?', target.id);

            if (this.auditService) {
                await this.auditService.record({
                    actorId: actor.userId,
                    actorUsername: actor.username,
                    actorRole: actor.role,
                    action: 'ACCOUNT_CLOSED',
                    entityType: 'ACCOUNT',
                    entityId: target.id,
                    details: {
                        accountNumber: target.account_number,
                        sweptAmount: currentBalance,
                        sweepTransactionId
                    },
                    status: 'SUCCESS'
                });
            }

            return {
                account: { ...closedAccount, balance: Number(closedAccount.balance) },
                sweptAmount: currentBalance,
                sweepTransactionId
            };
        });
    }

    /**
     * FR-20: Transaction statements per account with optional filters & verified running balance.
     */
    async getAccountStatement(accountId, requestingUser, filters = {}) {
        const account = await this.getAccountById(accountId);
        if (!account) {
            throw new Error('ACCOUNT_NOT_FOUND');
        }

        if (requestingUser.role === 'ACCOUNT_HOLDER' && account.owner_id !== requestingUser.userId) {
            throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
        }

        const entries = await this.db.all(`
            SELECT le.id as entry_id, le.direction, le.amount, le.created_at,
                   t.id as transaction_id, t.type as transaction_type,
                   t.description, t.idempotency_key, t.created_by,
                   t.source_account_id, t.destination_account_id
            FROM ledger_entries le
            JOIN transactions t ON le.transaction_id = t.id
            WHERE le.account_id = ?
            ORDER BY ${this.db.orderByInsertion('le', 'ASC')}
        `, accountId);

        // Compute authoritative chronological running balance across ALL entries first
        let calculatedBalance = 0;
        const entriesWithRunningBalance = entries.map(entry => {
            const amt = Number(entry.amount);
            if (account.account_type === 'SYSTEM_CLEARING') {
                if (entry.direction === 'DEBIT') calculatedBalance += amt;
                else calculatedBalance -= amt;
            } else {
                if (entry.direction === 'CREDIT') calculatedBalance += amt;
                else calculatedBalance -= amt;
            }
            return {
                ...entry,
                amount: amt,
                running_balance: calculatedBalance
            };
        });

        let filtered = entriesWithRunningBalance;
        if (filters.transactionType) {
            filtered = filtered.filter(e => e.transaction_type === filters.transactionType);
        }
        if (filters.fromDate) {
            filtered = filtered.filter(e => String(e.created_at) >= String(filters.fromDate));
        }
        if (filters.toDate) {
            filtered = filtered.filter(e => String(e.created_at).slice(0, 10) <= String(filters.toDate));
        }
        if (filters.search) {
            const q = String(filters.search).toLowerCase();
            filtered = filtered.filter(
                e =>
                    String(e.description || '').toLowerCase().includes(q) ||
                    String(e.idempotency_key || '').toLowerCase().includes(q)
            );
        }

        return {
            account,
            current_balance: account.balance,
            calculated_balance: calculatedBalance,
            is_balance_consistent: calculatedBalance === account.balance,
            total_unfiltered_entries: entriesWithRunningBalance.length,
            statement_entries: filtered
        };
    }
}

module.exports = { AccountService };
