// backend/src/services/ledgerService.js
const crypto = require('node:crypto');
const config = require('../config');

// Cap balances and single transactions well inside JavaScript MAX_SAFE_INTEGER (9e15 cents)
// so node:sqlite never stores 64-bit integers that overflow JS safe integer precision.
const MAX_SINGLE_TX_CENTS = 100_000_000_000;     // $1,000,000,000.00 per transaction
const MAX_SAFE_BALANCE_CENTS = 1_000_000_000_000_00; // $1,000,000,000,000.00 max account/vault balance

class LedgerService {
    constructor(db, auditService) {
        this.db = db;
        this.auditService = auditService;
    }

    validateAmountCents(amount) {
        if (typeof amount !== 'number' || amount <= 0 || !Number.isSafeInteger(amount)) {
            throw new Error('INVALID_AMOUNT_MUST_BE_POSITIVE_INTEGER_CENTS');
        }
        if (amount > MAX_SINGLE_TX_CENTS) {
            throw new Error('AMOUNT_EXCEEDS_SINGLE_TX_LIMIT');
        }
    }

    hashParams(params) {
        return crypto.createHash('sha256').update(JSON.stringify(params || {})).digest('hex');
    }

    async beginIdempotency(txDb, { idempotencyKey, userId, requestPath, paramsHash }) {
        const existingKey = await txDb.get(`
            SELECT status, response_code, response_body, request_params_hash
            FROM idempotency_keys
            WHERE key = ?
        `, idempotencyKey);

        if (existingKey) {
            if (existingKey.request_params_hash !== paramsHash) {
                throw new Error('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
            }
            if (existingKey.status === 'COMPLETED') {
                return {
                    isCached: true,
                    ...JSON.parse(existingKey.response_body)
                };
            }
            if (existingKey.status === 'IN_PROGRESS') {
                throw new Error('CONCURRENT_TRANSACTION_IN_PROGRESS');
            }
        }

        const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        const sql = txDb.dialect === 'postgres'
            ? `INSERT INTO idempotency_keys (key, user_id, request_path, request_params_hash, status, expires_at)
               VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
               ON CONFLICT (key) DO UPDATE SET user_id = EXCLUDED.user_id, request_path = EXCLUDED.request_path, request_params_hash = EXCLUDED.request_params_hash, status = 'IN_PROGRESS', expires_at = EXCLUDED.expires_at`
            : `INSERT OR REPLACE INTO idempotency_keys (key, user_id, request_path, request_params_hash, status, expires_at)
               VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)`;

        await txDb.run(sql, idempotencyKey, userId, requestPath, paramsHash, expiresAt);
        return null;
    }

    async deposit({ accountId, amount, idempotencyKey, description = 'Cash Deposit', actor }) {
        if (!accountId || amount === undefined || amount === null || !idempotencyKey) {
            throw new Error('MISSING_REQUIRED_PARAMETERS');
        }
        this.validateAmountCents(amount);

        const paramsHash = this.hashParams({ type: 'DEPOSIT', accountId, amount });

        return this.db.withTransaction(async (txDb) => {
            const cached = await this.beginIdempotency(txDb, {
                idempotencyKey,
                userId: actor.userId,
                requestPath: '/api/transactions/deposit',
                paramsHash
            });
            if (cached) return cached;

            await txDb.lockAccountsForUpdate([accountId, config.SYSTEM_CLEARING_ACCOUNT_ID]);

            const account = await txDb.get('SELECT id, owner_id, balance, status FROM accounts WHERE id = ?', accountId);
            if (!account) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'ACCOUNT_NOT_FOUND');
                throw new Error('ACCOUNT_NOT_FOUND');
            }

            if (actor.role === 'ACCOUNT_HOLDER' && account.owner_id !== actor.userId) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 403, 'UNAUTHORIZED_ACCOUNT_ACCESS');
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }

            if (account.status !== 'ACTIVE') {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'ACCOUNT_NOT_ACTIVE');
                throw new Error('ACCOUNT_NOT_ACTIVE');
            }

            const clearingAccount = await txDb.get(
                'SELECT id, balance FROM accounts WHERE id = ?',
                config.SYSTEM_CLEARING_ACCOUNT_ID
            );
            if (!clearingAccount) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 500, 'SYSTEM_CLEARING_ACCOUNT_MISSING');
                throw new Error('SYSTEM_CLEARING_ACCOUNT_MISSING');
            }

            const transactionId = 'tx_' + crypto.randomUUID();
            const currentBalance = Number(account.balance);
            const clearingBalance = Number(clearingAccount.balance);

            if (
                !Number.isSafeInteger(currentBalance + amount) ||
                currentBalance + amount > MAX_SAFE_BALANCE_CENTS ||
                !Number.isSafeInteger(clearingBalance + amount) ||
                clearingBalance + amount > MAX_SAFE_BALANCE_CENTS
            ) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'BALANCE_LIMIT_EXCEEDED');
                throw new Error('BALANCE_LIMIT_EXCEEDED');
            }

            await txDb.run(
                'UPDATE accounts SET balance = balance + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                amount, account.id
            );
            await txDb.run(
                'UPDATE accounts SET balance = balance + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                amount, clearingAccount.id
            );

            await txDb.run(`
                INSERT INTO transactions (id, type, idempotency_key, destination_account_id, amount, status, description, created_by)
                VALUES (?, 'DEPOSIT', ?, ?, ?, 'COMPLETED', ?, ?)
            `, transactionId, idempotencyKey, account.id, amount, description, actor.userId);

            await txDb.run(
                `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'DEBIT', ?)`,
                'le_' + crypto.randomUUID(), transactionId, clearingAccount.id, amount
            );
            await txDb.run(
                `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'CREDIT', ?)`,
                'le_' + crypto.randomUUID(), transactionId, account.id, amount
            );

            await this.assertTransactionBalanced(txDb, transactionId);

            const result = {
                transactionId,
                type: 'DEPOSIT',
                amount,
                accountId: account.id,
                newBalance: currentBalance + amount,
                timestamp: new Date().toISOString()
            };

            await txDb.run(`
                UPDATE idempotency_keys
                SET status = 'COMPLETED', response_code = 200, response_body = ?
                WHERE key = ?
            `, JSON.stringify(result), idempotencyKey);

            if (this.auditService) {
                await this.auditService.record({
                    actorId: actor.userId,
                    actorUsername: actor.username,
                    actorRole: actor.role,
                    action: 'DEPOSIT_EXECUTED',
                    entityType: 'TRANSACTION',
                    entityId: transactionId,
                    details: { amount, accountId: account.id, idempotencyKey },
                    status: 'SUCCESS'
                });
            }

            return result;
        });
    }

    async withdraw({ accountId, amount, idempotencyKey, description = 'Cash Withdrawal', actor }) {
        if (!accountId || amount === undefined || amount === null || !idempotencyKey) {
            throw new Error('MISSING_REQUIRED_PARAMETERS');
        }
        this.validateAmountCents(amount);

        const paramsHash = this.hashParams({ type: 'WITHDRAWAL', accountId, amount });

        return this.db.withTransaction(async (txDb) => {
            const cached = await this.beginIdempotency(txDb, {
                idempotencyKey,
                userId: actor.userId,
                requestPath: '/api/transactions/withdraw',
                paramsHash
            });
            if (cached) return cached;

            await txDb.lockAccountsForUpdate([accountId, config.SYSTEM_CLEARING_ACCOUNT_ID]);

            const sourceAccount = await txDb.get('SELECT id, owner_id, balance, status FROM accounts WHERE id = ?', accountId);
            if (!sourceAccount) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'ACCOUNT_NOT_FOUND');
                throw new Error('ACCOUNT_NOT_FOUND');
            }

            if (actor.role === 'ACCOUNT_HOLDER' && sourceAccount.owner_id !== actor.userId) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 403, 'UNAUTHORIZED_ACCOUNT_ACCESS');
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }

            if (sourceAccount.status !== 'ACTIVE') {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'ACCOUNT_NOT_ACTIVE');
                throw new Error('ACCOUNT_NOT_ACTIVE');
            }

            const currentBalance = Number(sourceAccount.balance);
            if (currentBalance < amount) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'INSUFFICIENT_FUNDS');
                if (this.auditService) {
                    await this.auditService.record({
                        actorId: actor.userId,
                        actorUsername: actor.username,
                        actorRole: actor.role,
                        action: 'WITHDRAWAL_FAILED_INSUFFICIENT_FUNDS',
                        entityType: 'ACCOUNT',
                        entityId: accountId,
                        details: { attemptedAmount: amount, currentBalance },
                        status: 'FAILURE'
                    });
                }
                throw new Error('INSUFFICIENT_FUNDS');
            }

            const clearingAccount = await txDb.get(
                'SELECT id, balance FROM accounts WHERE id = ?',
                config.SYSTEM_CLEARING_ACCOUNT_ID
            );
            if (!clearingAccount) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 500, 'SYSTEM_CLEARING_ACCOUNT_MISSING');
                throw new Error('SYSTEM_CLEARING_ACCOUNT_MISSING');
            }

            const transactionId = 'tx_' + crypto.randomUUID();

            await txDb.run(
                'UPDATE accounts SET balance = balance - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                amount, sourceAccount.id
            );
            await txDb.run(
                'UPDATE accounts SET balance = balance - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                amount, clearingAccount.id
            );

            await txDb.run(`
                INSERT INTO transactions (id, type, idempotency_key, source_account_id, amount, status, description, created_by)
                VALUES (?, 'WITHDRAWAL', ?, ?, ?, 'COMPLETED', ?, ?)
            `, transactionId, idempotencyKey, sourceAccount.id, amount, description, actor.userId);

            await txDb.run(
                `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'DEBIT', ?)`,
                'le_' + crypto.randomUUID(), transactionId, sourceAccount.id, amount
            );
            await txDb.run(
                `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'CREDIT', ?)`,
                'le_' + crypto.randomUUID(), transactionId, clearingAccount.id, amount
            );

            await this.assertTransactionBalanced(txDb, transactionId);

            const result = {
                transactionId,
                type: 'WITHDRAWAL',
                amount,
                sourceAccountId: sourceAccount.id,
                newBalance: currentBalance - amount,
                timestamp: new Date().toISOString()
            };

            await txDb.run(`
                UPDATE idempotency_keys
                SET status = 'COMPLETED', response_code = 200, response_body = ?
                WHERE key = ?
            `, JSON.stringify(result), idempotencyKey);

            if (this.auditService) {
                await this.auditService.record({
                    actorId: actor.userId,
                    actorUsername: actor.username,
                    actorRole: actor.role,
                    action: 'WITHDRAWAL_EXECUTED',
                    entityType: 'TRANSACTION',
                    entityId: transactionId,
                    details: { amount, accountId: sourceAccount.id, idempotencyKey },
                    status: 'SUCCESS'
                });
            }

            return result;
        });
    }

    async transfer({
        sourceAccountId,
        destinationAccountId = null,
        destinationAccountNumber = null,
        amount,
        idempotencyKey,
        description = 'Account Transfer',
        actor
    }) {
        if (!sourceAccountId || (!destinationAccountId && !destinationAccountNumber) || amount === undefined || amount === null || !idempotencyKey) {
            throw new Error('MISSING_REQUIRED_PARAMETERS');
        }
        this.validateAmountCents(amount);

        let resolvedDestId = destinationAccountId;
        if (!resolvedDestId && destinationAccountNumber) {
            const destLookup = await this.db.get(
                'SELECT id FROM accounts WHERE account_number = ?',
                destinationAccountNumber.trim()
            );
            if (!destLookup) {
                throw new Error('DESTINATION_ACCOUNT_NOT_FOUND');
            }
            resolvedDestId = destLookup.id;
        }

        if (sourceAccountId === resolvedDestId) {
            throw new Error('CANNOT_TRANSFER_TO_SAME_ACCOUNT');
        }

        const paramsHash = this.hashParams({
            type: 'TRANSFER',
            sourceAccountId,
            destinationAccountId: resolvedDestId,
            amount
        });

        return this.db.withTransaction(async (txDb) => {
            const cached = await this.beginIdempotency(txDb, {
                idempotencyKey,
                userId: actor.userId,
                requestPath: '/api/transactions/transfer',
                paramsHash
            });
            if (cached) return cached;

            await txDb.lockAccountsForUpdate([sourceAccountId, resolvedDestId]);

            const sourceAccount = await txDb.get('SELECT id, owner_id, balance, status FROM accounts WHERE id = ?', sourceAccountId);
            if (!sourceAccount) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'SOURCE_ACCOUNT_NOT_FOUND');
                throw new Error('SOURCE_ACCOUNT_NOT_FOUND');
            }

            if (actor.role === 'ACCOUNT_HOLDER' && sourceAccount.owner_id !== actor.userId) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 403, 'UNAUTHORIZED_ACCOUNT_ACCESS');
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }

            const destAccount = await txDb.get('SELECT id, owner_id, balance, status FROM accounts WHERE id = ?', resolvedDestId);
            if (!destAccount) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'DESTINATION_ACCOUNT_NOT_FOUND');
                throw new Error('DESTINATION_ACCOUNT_NOT_FOUND');
            }

            if (sourceAccount.status !== 'ACTIVE' || destAccount.status !== 'ACTIVE') {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'ACCOUNT_NOT_ACTIVE');
                throw new Error('ACCOUNT_NOT_ACTIVE');
            }

            const sourceBalance = Number(sourceAccount.balance);
            const destBalance = Number(destAccount.balance);

            if (sourceBalance < amount) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'INSUFFICIENT_FUNDS');
                if (this.auditService) {
                    await this.auditService.record({
                        actorId: actor.userId,
                        actorUsername: actor.username,
                        actorRole: actor.role,
                        action: 'TRANSFER_FAILED_INSUFFICIENT_FUNDS',
                        entityType: 'ACCOUNT',
                        entityId: sourceAccountId,
                        details: { attemptedAmount: amount, currentBalance: sourceBalance, destinationAccountId: resolvedDestId },
                        status: 'FAILURE'
                    });
                }
                throw new Error('INSUFFICIENT_FUNDS');
            }

            if (!Number.isSafeInteger(destBalance + amount) || destBalance + amount > MAX_SAFE_BALANCE_CENTS) {
                await this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'BALANCE_LIMIT_EXCEEDED');
                throw new Error('BALANCE_LIMIT_EXCEEDED');
            }

            const transactionId = 'tx_' + crypto.randomUUID();

            await txDb.run(
                'UPDATE accounts SET balance = balance - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                amount, sourceAccount.id
            );
            await txDb.run(
                'UPDATE accounts SET balance = balance + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                amount, destAccount.id
            );

            await txDb.run(`
                INSERT INTO transactions (id, type, idempotency_key, source_account_id, destination_account_id, amount, status, description, created_by)
                VALUES (?, 'TRANSFER', ?, ?, ?, ?, 'COMPLETED', ?, ?)
            `, transactionId, idempotencyKey, sourceAccount.id, destAccount.id, amount, description, actor.userId);

            await txDb.run(
                `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'DEBIT', ?)`,
                'le_' + crypto.randomUUID(), transactionId, sourceAccount.id, amount
            );
            await txDb.run(
                `INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount) VALUES (?, ?, ?, 'CREDIT', ?)`,
                'le_' + crypto.randomUUID(), transactionId, destAccount.id, amount
            );

            await this.assertTransactionBalanced(txDb, transactionId);

            const result = {
                transactionId,
                type: 'TRANSFER',
                amount,
                sourceAccountId: sourceAccount.id,
                destinationAccountId: destAccount.id,
                sourceNewBalance: sourceBalance - amount,
                destinationNewBalance: destBalance + amount,
                timestamp: new Date().toISOString()
            };

            await txDb.run(`
                UPDATE idempotency_keys
                SET status = 'COMPLETED', response_code = 200, response_body = ?
                WHERE key = ?
            `, JSON.stringify(result), idempotencyKey);

            if (this.auditService) {
                await this.auditService.record({
                    actorId: actor.userId,
                    actorUsername: actor.username,
                    actorRole: actor.role,
                    action: 'TRANSFER_EXECUTED',
                    entityType: 'TRANSACTION',
                    entityId: transactionId,
                    details: { amount, sourceAccountId: sourceAccount.id, destinationAccountId: destAccount.id, idempotencyKey },
                    status: 'SUCCESS'
                });
            }

            return result;
        });
    }

    async markIdempotencyFailed(db, key, code, message) {
        try {
            await db.run(`
                UPDATE idempotency_keys
                SET status = 'FAILED', response_code = ?, response_body = ?
                WHERE key = ?
            `, code, JSON.stringify({ error: message }), key);
        } catch (_) {}
    }

    async assertTransactionBalanced(db, transactionId) {
        const stats = await db.get(`
            SELECT
                COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) as total_debit,
                COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) as total_credit
            FROM ledger_entries
            WHERE transaction_id = ?
        `, transactionId);

        const debits = Number(stats.total_debit || 0);
        const credits = Number(stats.total_credit || 0);

        if (debits !== credits) {
            throw new Error(`DOUBLE_ENTRY_INVARIANCE_VIOLATION: Transaction ${transactionId} Debits (${debits}) != Credits (${credits})`);
        }
    }

    async verifyConservation() {
        const ledgerStats = await this.db.get(`
            SELECT
                COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) as total_debits,
                COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) as total_credits,
                COUNT(*) as entry_count
            FROM ledger_entries
        `);

        const totalDebits = Number(ledgerStats.total_debits || 0);
        const totalCredits = Number(ledgerStats.total_credits || 0);
        const isLedgerBalanced = totalDebits === totalCredits;

        const customerBalanceStats = await this.db.get(`
            SELECT COALESCE(SUM(balance), 0) as total_customer_balances
            FROM accounts
            WHERE account_type != 'SYSTEM_CLEARING'
        `);

        const clearingAccount = await this.db.get(
            'SELECT balance FROM accounts WHERE id = ?',
            config.SYSTEM_CLEARING_ACCOUNT_ID
        );

        const totalCustomerBalances = Number(customerBalanceStats.total_customer_balances || 0);
        const clearingBalance = clearingAccount ? Number(clearingAccount.balance) : 0;
        const isClearingConsistent = totalCustomerBalances === clearingBalance;

        const unbalancedRow = await this.db.get(`
            SELECT COUNT(*) as count FROM (
                SELECT transaction_id
                FROM ledger_entries
                GROUP BY transaction_id
                HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) != 0
            ) sub
        `);
        const unbalancedTxCount = Number(unbalancedRow.count || 0);

        return {
            is_valid: isLedgerBalanced && isClearingConsistent && unbalancedTxCount === 0,
            ledger_stats: {
                total_debits: totalDebits,
                total_credits: totalCredits,
                difference: totalDebits - totalCredits,
                total_entries: Number(ledgerStats.entry_count || 0)
            },
            balance_stats: {
                total_customer_balances: totalCustomerBalances,
                clearing_vault_balance: clearingBalance,
                is_consistent: isClearingConsistent
            },
            unbalanced_transactions_count: unbalancedTxCount,
            verified_at: new Date().toISOString()
        };
    }

    async getTransactions({ limit = 50, offset = 0, accountId = null, requestingUser = null, type = null } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const safeOffset = Math.max(Number(offset) || 0, 0);

        let query = `
            SELECT t.*, u.username as created_by_username
            FROM transactions t
            JOIN users u ON t.created_by = u.id
            WHERE 1=1
        `;
        const params = [];

        if (accountId) {
            if (requestingUser && requestingUser.role === 'ACCOUNT_HOLDER') {
                const target = await this.db.get('SELECT owner_id FROM accounts WHERE id = ?', accountId);
                if (!target) {
                    throw new Error('ACCOUNT_NOT_FOUND');
                }
                if (target.owner_id !== requestingUser.userId) {
                    throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
                }
            }
            query += ' AND (t.source_account_id = ? OR t.destination_account_id = ?)';
            params.push(accountId, accountId);
        } else if (requestingUser && requestingUser.role === 'ACCOUNT_HOLDER') {
            query += ` AND (
                t.source_account_id IN (SELECT id FROM accounts WHERE owner_id = ?)
                OR t.destination_account_id IN (SELECT id FROM accounts WHERE owner_id = ?)
            )`;
            params.push(requestingUser.userId, requestingUser.userId);
        }

        if (type) {
            query += ' AND t.type = ?';
            params.push(type);
        }

        query += ` ORDER BY ${this.db.orderByInsertion('t', 'DESC')} LIMIT ? OFFSET ?`;
        params.push(safeLimit, safeOffset);

        const rows = await this.db.all(query, ...params);
        return rows.map(r => ({ ...r, amount: Number(r.amount) }));
    }

    async getIdempotencyHistory(userId, limit = 20) {
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        return this.db.all(`
            SELECT key, request_path, status, response_code, created_at, expires_at
            FROM idempotency_keys
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `, userId, safeLimit);
    }
}

module.exports = { LedgerService };
