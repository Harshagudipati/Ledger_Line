// backend/src/services/ledgerService.js
const crypto = require('node:crypto');
const { withTransaction } = require('../db/database');
const config = require('../config');

class LedgerService {
    constructor(db, auditService) {
        this.db = db;
        this.auditService = auditService;
    }

    /**
     * Compute SHA-256 hash of request parameters for idempotency validation.
     */
    hashParams(params) {
        return crypto.createHash('sha256').update(JSON.stringify(params || {})).digest('hex');
    }

    /**
     * Check idempotency registry or mark key IN_PROGRESS inside active transaction.
     * Returns cached payload object if already completed, otherwise null.
     */
    beginIdempotency(txDb, { idempotencyKey, userId, requestPath, paramsHash }) {
        const existingKey = txDb.prepare(`
            SELECT status, response_code, response_body, request_params_hash
            FROM idempotency_keys
            WHERE key = ?
        `).get(idempotencyKey);

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
        txDb.prepare(`
            INSERT OR REPLACE INTO idempotency_keys (key, user_id, request_path, request_params_hash, status, expires_at)
            VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
        `).run(idempotencyKey, userId, requestPath, paramsHash, expiresAt);

        return null;
    }

    /**
     * FR-11: Deposit money into an account.
     * Generates double-entry:
     * - DEBIT: System Clearing Account (Cash Reserve Increase)
     * - CREDIT: Destination Customer Account (Balance Increase)
     */
    deposit({ accountId, amount, idempotencyKey, description = 'Cash Deposit', actor }) {
        if (!accountId || !amount || !idempotencyKey) {
            throw new Error('MISSING_REQUIRED_PARAMETERS');
        }
        if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
            throw new Error('INVALID_AMOUNT_MUST_BE_POSITIVE_INTEGER_CENTS');
        }

        const paramsHash = this.hashParams({ type: 'DEPOSIT', accountId, amount });

        return withTransaction(this.db, (txDb) => {
            const cached = this.beginIdempotency(txDb, {
                idempotencyKey,
                userId: actor.userId,
                requestPath: '/api/transactions/deposit',
                paramsHash
            });
            if (cached) return cached;

            // Fetch target account
            const destAccount = txDb.prepare('SELECT id, owner_id, balance, status FROM accounts WHERE id = ?').get(accountId);
            if (!destAccount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'ACCOUNT_NOT_FOUND');
                throw new Error('ACCOUNT_NOT_FOUND');
            }

            // FR-3: Account-level ownership check
            if (actor.role === 'ACCOUNT_HOLDER' && destAccount.owner_id !== actor.userId) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 403, 'UNAUTHORIZED_ACCOUNT_ACCESS');
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }

            if (destAccount.status !== 'ACTIVE') {
                this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'ACCOUNT_NOT_ACTIVE');
                throw new Error('ACCOUNT_NOT_ACTIVE');
            }

            // Fetch clearing account
            const clearingAccount = txDb.prepare('SELECT id, balance FROM accounts WHERE id = ?').get(config.SYSTEM_CLEARING_ACCOUNT_ID);
            if (!clearingAccount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 500, 'SYSTEM_CLEARING_ACCOUNT_MISSING');
                throw new Error('SYSTEM_CLEARING_ACCOUNT_MISSING');
            }

            const transactionId = 'tx_' + crypto.randomUUID();
            const debitEntryId = 'le_' + crypto.randomUUID();
            const creditEntryId = 'le_' + crypto.randomUUID();

            // Update balances
            txDb.prepare('UPDATE accounts SET balance = balance + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(amount, destAccount.id);
            txDb.prepare('UPDATE accounts SET balance = balance + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(amount, clearingAccount.id);

            // Create Transaction record
            txDb.prepare(`
                INSERT INTO transactions (id, type, idempotency_key, destination_account_id, amount, status, description, created_by)
                VALUES (?, 'DEPOSIT', ?, ?, ?, 'COMPLETED', ?, ?)
            `).run(transactionId, idempotencyKey, destAccount.id, amount, description, actor.userId);

            // Create Double-Entry Ledger lines
            // 1. DEBIT: Clearing / Cash Reserve
            txDb.prepare(`
                INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
                VALUES (?, ?, ?, 'DEBIT', ?)
            `).run(debitEntryId, transactionId, clearingAccount.id, amount);

            // 2. CREDIT: Customer Account
            txDb.prepare(`
                INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
                VALUES (?, ?, ?, 'CREDIT', ?)
            `).run(creditEntryId, transactionId, destAccount.id, amount);

            // Conservation validation check inside transaction
            this.assertTransactionBalanced(txDb, transactionId);

            const result = {
                transactionId,
                type: 'DEPOSIT',
                amount,
                destinationAccountId: destAccount.id,
                newBalance: destAccount.balance + amount,
                timestamp: new Date().toISOString()
            };

            // Complete Idempotency record
            txDb.prepare(`
                UPDATE idempotency_keys
                SET status = 'COMPLETED', response_code = 200, response_body = ?
                WHERE key = ?
            `).run(JSON.stringify(result), idempotencyKey);

            if (this.auditService) {
                this.auditService.record({
                    actorId: actor.userId,
                    actorUsername: actor.username,
                    actorRole: actor.role,
                    action: 'DEPOSIT_EXECUTED',
                    entityType: 'TRANSACTION',
                    entityId: transactionId,
                    details: { amount, accountId, idempotencyKey },
                    status: 'SUCCESS'
                });
            }

            return result;
        });
    }

    /**
     * FR-12: Withdraw money from an account.
     * Generates double-entry:
     * - DEBIT: Customer Account (Balance Decrease)
     * - CREDIT: System Clearing Account (Cash Reserve Decrease)
     * Strictly protects against negative balances!
     */
    withdraw({ accountId, amount, idempotencyKey, description = 'Cash Withdrawal', actor }) {
        if (!accountId || !amount || !idempotencyKey) {
            throw new Error('MISSING_REQUIRED_PARAMETERS');
        }
        if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
            throw new Error('INVALID_AMOUNT_MUST_BE_POSITIVE_INTEGER_CENTS');
        }

        const paramsHash = this.hashParams({ type: 'WITHDRAWAL', accountId, amount });

        return withTransaction(this.db, (txDb) => {
            const cached = this.beginIdempotency(txDb, {
                idempotencyKey,
                userId: actor.userId,
                requestPath: '/api/transactions/withdraw',
                paramsHash
            });
            if (cached) return cached;

            // Fetch source account
            const sourceAccount = txDb.prepare('SELECT id, owner_id, balance, status FROM accounts WHERE id = ?').get(accountId);
            if (!sourceAccount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'ACCOUNT_NOT_FOUND');
                throw new Error('ACCOUNT_NOT_FOUND');
            }

            // FR-3: Account-level ownership check
            if (actor.role === 'ACCOUNT_HOLDER' && sourceAccount.owner_id !== actor.userId) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 403, 'UNAUTHORIZED_ACCOUNT_ACCESS');
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }

            if (sourceAccount.status !== 'ACTIVE') {
                this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'ACCOUNT_NOT_ACTIVE');
                throw new Error('ACCOUNT_NOT_ACTIVE');
            }

            // FR-10: Server-side negative-balance prevention
            if (sourceAccount.balance < amount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'INSUFFICIENT_FUNDS');
                if (this.auditService) {
                    this.auditService.record({
                        actorId: actor.userId,
                        actorUsername: actor.username,
                        actorRole: actor.role,
                        action: 'WITHDRAWAL_FAILED_INSUFFICIENT_FUNDS',
                        entityType: 'ACCOUNT',
                        entityId: accountId,
                        details: { attemptedAmount: amount, currentBalance: sourceAccount.balance },
                        status: 'FAILURE'
                    });
                }
                throw new Error('INSUFFICIENT_FUNDS');
            }

            // Fetch clearing account
            const clearingAccount = txDb.prepare('SELECT id, balance FROM accounts WHERE id = ?').get(config.SYSTEM_CLEARING_ACCOUNT_ID);
            if (!clearingAccount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 500, 'SYSTEM_CLEARING_ACCOUNT_MISSING');
                throw new Error('SYSTEM_CLEARING_ACCOUNT_MISSING');
            }

            const transactionId = 'tx_' + crypto.randomUUID();
            const debitEntryId = 'le_' + crypto.randomUUID();
            const creditEntryId = 'le_' + crypto.randomUUID();

            // Update balances
            txDb.prepare('UPDATE accounts SET balance = balance - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(amount, sourceAccount.id);
            txDb.prepare('UPDATE accounts SET balance = balance - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(amount, clearingAccount.id);

            // Record transaction
            txDb.prepare(`
                INSERT INTO transactions (id, type, idempotency_key, source_account_id, amount, status, description, created_by)
                VALUES (?, 'WITHDRAWAL', ?, ?, ?, 'COMPLETED', ?, ?)
            `).run(transactionId, idempotencyKey, sourceAccount.id, amount, description, actor.userId);

            // Double-Entry Ledger
            // 1. DEBIT: Customer Account (Balance reduction)
            txDb.prepare(`
                INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
                VALUES (?, ?, ?, 'DEBIT', ?)
            `).run(debitEntryId, transactionId, sourceAccount.id, amount);

            // 2. CREDIT: Clearing / Cash Reserve
            txDb.prepare(`
                INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
                VALUES (?, ?, ?, 'CREDIT', ?)
            `).run(creditEntryId, transactionId, clearingAccount.id, amount);

            // Conservation validation check inside transaction
            this.assertTransactionBalanced(txDb, transactionId);

            const result = {
                transactionId,
                type: 'WITHDRAWAL',
                amount,
                sourceAccountId: sourceAccount.id,
                newBalance: sourceAccount.balance - amount,
                timestamp: new Date().toISOString()
            };

            // Complete Idempotency record
            txDb.prepare(`
                UPDATE idempotency_keys
                SET status = 'COMPLETED', response_code = 200, response_body = ?
                WHERE key = ?
            `).run(JSON.stringify(result), idempotencyKey);

            if (this.auditService) {
                this.auditService.record({
                    actorId: actor.userId,
                    actorUsername: actor.username,
                    actorRole: actor.role,
                    action: 'WITHDRAWAL_EXECUTED',
                    entityType: 'TRANSACTION',
                    entityId: transactionId,
                    details: { amount, accountId, idempotencyKey },
                    status: 'SUCCESS'
                });
            }

            return result;
        });
    }

    /**
     * FR-13: Transfer money between accounts.
     * Supports destinationAccountId OR destinationAccountNumber.
     * Generates double-entry:
     * - DEBIT: Source Account (Balance Decrease)
     * - CREDIT: Destination Account (Balance Increase)
     * Atomic, isolated, zero-sum, idempotent.
     */
    transfer({ sourceAccountId, destinationAccountId = null, destinationAccountNumber = null, amount, idempotencyKey, description = 'Account Transfer', actor }) {
        const destinationRef = destinationAccountId || destinationAccountNumber;
        if (!sourceAccountId || !destinationRef || !amount || !idempotencyKey) {
            throw new Error('MISSING_REQUIRED_PARAMETERS');
        }
        if (destinationAccountId && sourceAccountId === destinationAccountId) {
            throw new Error('CANNOT_TRANSFER_TO_SAME_ACCOUNT');
        }
        if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
            throw new Error('INVALID_AMOUNT_MUST_BE_POSITIVE_INTEGER_CENTS');
        }

        const paramsHash = this.hashParams({ type: 'TRANSFER', sourceAccountId, destinationRef, amount });

        return withTransaction(this.db, (txDb) => {
            const cached = this.beginIdempotency(txDb, {
                idempotencyKey,
                userId: actor.userId,
                requestPath: '/api/transactions/transfer',
                paramsHash
            });
            if (cached) return cached;

            // Fetch accounts
            const sourceAccount = txDb.prepare('SELECT id, account_number, owner_id, balance, status FROM accounts WHERE id = ?').get(sourceAccountId);
            if (!sourceAccount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'SOURCE_ACCOUNT_NOT_FOUND');
                throw new Error('SOURCE_ACCOUNT_NOT_FOUND');
            }

            const destAccount = destinationAccountId
                ? txDb.prepare('SELECT id, account_number, owner_id, balance, status FROM accounts WHERE id = ?').get(destinationAccountId)
                : txDb.prepare('SELECT id, account_number, owner_id, balance, status FROM accounts WHERE account_number = ?').get(destinationAccountNumber);

            if (!destAccount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 404, 'DESTINATION_ACCOUNT_NOT_FOUND');
                throw new Error('DESTINATION_ACCOUNT_NOT_FOUND');
            }

            if (sourceAccount.id === destAccount.id) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'CANNOT_TRANSFER_TO_SAME_ACCOUNT');
                throw new Error('CANNOT_TRANSFER_TO_SAME_ACCOUNT');
            }

            // FR-3: Account-level ownership check
            if (actor.role === 'ACCOUNT_HOLDER' && sourceAccount.owner_id !== actor.userId) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 403, 'UNAUTHORIZED_ACCOUNT_ACCESS');
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }

            if (sourceAccount.status !== 'ACTIVE' || destAccount.status !== 'ACTIVE') {
                this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'ACCOUNT_NOT_ACTIVE');
                throw new Error('ACCOUNT_NOT_ACTIVE');
            }

            // FR-10: Server-side negative balance prevention
            if (sourceAccount.balance < amount) {
                this.markIdempotencyFailed(txDb, idempotencyKey, 400, 'INSUFFICIENT_FUNDS');
                if (this.auditService) {
                    this.auditService.record({
                        actorId: actor.userId,
                        actorUsername: actor.username,
                        actorRole: actor.role,
                        action: 'TRANSFER_FAILED_INSUFFICIENT_FUNDS',
                        entityType: 'ACCOUNT',
                        entityId: sourceAccountId,
                        details: { attemptedAmount: amount, currentBalance: sourceAccount.balance },
                        status: 'FAILURE'
                    });
                }
                throw new Error('INSUFFICIENT_FUNDS');
            }

            const transactionId = 'tx_' + crypto.randomUUID();
            const debitEntryId = 'le_' + crypto.randomUUID();
            const creditEntryId = 'le_' + crypto.randomUUID();

            // Update balances
            txDb.prepare('UPDATE accounts SET balance = balance - ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(amount, sourceAccount.id);
            txDb.prepare('UPDATE accounts SET balance = balance + ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                .run(amount, destAccount.id);

            // Record transaction
            txDb.prepare(`
                INSERT INTO transactions (id, type, idempotency_key, source_account_id, destination_account_id, amount, status, description, created_by)
                VALUES (?, 'TRANSFER', ?, ?, ?, ?, 'COMPLETED', ?, ?)
            `).run(transactionId, idempotencyKey, sourceAccount.id, destAccount.id, amount, description, actor.userId);

            // Double-Entry Ledger Lines
            // 1. DEBIT: Source Account
            txDb.prepare(`
                INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
                VALUES (?, ?, ?, 'DEBIT', ?)
            `).run(debitEntryId, transactionId, sourceAccount.id, amount);

            // 2. CREDIT: Destination Account
            txDb.prepare(`
                INSERT INTO ledger_entries (id, transaction_id, account_id, direction, amount)
                VALUES (?, ?, ?, 'CREDIT', ?)
            `).run(creditEntryId, transactionId, destAccount.id, amount);

            // Conservation validation check inside transaction
            this.assertTransactionBalanced(txDb, transactionId);

            const result = {
                transactionId,
                type: 'TRANSFER',
                amount,
                sourceAccountId: sourceAccount.id,
                destinationAccountId: destAccount.id,
                sourceNewBalance: sourceAccount.balance - amount,
                destinationNewBalance: destAccount.balance + amount,
                timestamp: new Date().toISOString()
            };

            // Complete Idempotency record
            txDb.prepare(`
                UPDATE idempotency_keys
                SET status = 'COMPLETED', response_code = 200, response_body = ?
                WHERE key = ?
            `).run(JSON.stringify(result), idempotencyKey);

            if (this.auditService) {
                this.auditService.record({
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

    /**
     * Mark an idempotency key as failed.
     */
    markIdempotencyFailed(db, key, code, message) {
        try {
            db.prepare(`
                UPDATE idempotency_keys
                SET status = 'FAILED', response_code = ?, response_body = ?
                WHERE key = ?
            `).run(code, JSON.stringify({ error: message }), key);
        } catch (_) {}
    }

    /**
     * FR-14: Double-entry assertion for an individual transaction.
     * Ensures total debits equal total credits.
     */
    assertTransactionBalanced(db, transactionId) {
        const stats = db.prepare(`
            SELECT 
                SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as total_debit,
                SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as total_credit
            FROM ledger_entries
            WHERE transaction_id = ?
        `).get(transactionId);

        const debits = stats.total_debit || 0;
        const credits = stats.total_credit || 0;

        if (debits !== credits) {
            throw new Error(`DOUBLE_ENTRY_IMBALANCE: Debits (${debits}) do not equal Credits (${credits}) for transaction ${transactionId}`);
        }
    }

    /**
     * FR-15: System-wide money conservation checks.
     * Total debits across the entire ledger must equal total credits.
     * Total customer balances must match the system clearing balance.
     */
    verifyConservation() {
        // 1. Verify all ledger entries sum to zero
        const ledgerStats = this.db.prepare(`
            SELECT 
                SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as total_debits,
                SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as total_credits,
                COUNT(*) as entry_count
            FROM ledger_entries
        `).get();

        const totalDebits = ledgerStats.total_debits || 0;
        const totalCredits = ledgerStats.total_credits || 0;
        const isLedgerBalanced = totalDebits === totalCredits;

        // 2. Verify account balances against clearing vault
        const customerBalanceStats = this.db.prepare(`
            SELECT SUM(balance) as total_customer_balances
            FROM accounts
            WHERE account_type != 'SYSTEM_CLEARING'
        `).get();

        const clearingAccount = this.db.prepare(`
            SELECT balance FROM accounts WHERE id = ?
        `).get(config.SYSTEM_CLEARING_ACCOUNT_ID);

        const totalCustomerBalances = customerBalanceStats.total_customer_balances || 0;
        const clearingBalance = clearingAccount ? clearingAccount.balance : 0;
        const isClearingConsistent = totalCustomerBalances === clearingBalance;

        // 3. Count any individual unbalanced transactions
        const unbalancedTxCount = this.db.prepare(`
            SELECT COUNT(*) as count FROM (
                SELECT transaction_id
                FROM ledger_entries
                GROUP BY transaction_id
                HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) != 0
            )
        `).get().count;

        return {
            is_valid: isLedgerBalanced && isClearingConsistent && unbalancedTxCount === 0,
            ledger_stats: {
                total_debits: totalDebits,
                total_credits: totalCredits,
                difference: totalDebits - totalCredits,
                total_entries: ledgerStats.entry_count
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

    /**
     * Get all transactions (for Admin/Auditor) or account-specific transactions.
     * Enforces FR-3 ownership checks when requestingUser is an ACCOUNT_HOLDER.
     */
    getTransactions({ limit = 50, offset = 0, accountId = null, requestingUser = null }) {
        if (accountId && requestingUser && requestingUser.role === 'ACCOUNT_HOLDER') {
            const account = this.db.prepare('SELECT id, owner_id FROM accounts WHERE id = ?').get(accountId);
            if (!account) {
                throw new Error('ACCOUNT_NOT_FOUND');
            }
            if (account.owner_id !== requestingUser.userId) {
                throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
            }
        }

        let query = `
            SELECT t.id, t.type, t.idempotency_key, t.source_account_id,
                   t.destination_account_id, t.amount, t.status, t.description,
                   t.created_by, t.created_at, u.username as creator_username
            FROM transactions t
            JOIN users u ON t.created_by = u.id
            LEFT JOIN accounts src ON t.source_account_id = src.id
            LEFT JOIN accounts dst ON t.destination_account_id = dst.id
            WHERE 1=1
        `;
        const params = [];

        if (requestingUser && requestingUser.role === 'ACCOUNT_HOLDER') {
            query += ' AND (src.owner_id = ? OR dst.owner_id = ?)';
            params.push(requestingUser.userId, requestingUser.userId);
        }

        if (accountId) {
            query += ' AND (t.source_account_id = ? OR t.destination_account_id = ?)';
            params.push(accountId, accountId);
        }

        query += ' ORDER BY t.created_at DESC, t.rowid DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        return this.db.prepare(query).all(...params);
    }
}

module.exports = { LedgerService };

