// backend/tests/ledger.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { AccountService } = require('../src/services/accountService');
const { LedgerService } = require('../src/services/ledgerService');
const { AuditService } = require('../src/services/auditService');
const { TEST_PASSWORDS } = require('./testFixtures');

async function testLedger() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 3: Double-Entry Ledger & Conservation');
    console.log('======================================================');

    const db = getDatabase(':memory:', true);
    const seeded = await seedDatabase(db, { passwords: TEST_PASSWORDS, forceDemoUsers: true });

    const auditService = new AuditService(db);
    const accountService = new AccountService(db, auditService);
    const ledgerService = new LedgerService(db, auditService);

    const alice = { userId: seeded.alice.id, username: 'alice', role: 'ACCOUNT_HOLDER' };
    const bob = { userId: seeded.bob.id, username: 'bob', role: 'ACCOUNT_HOLDER' };

    const aliceAcc = (await accountService.getAccountsForUser(alice))[0];
    const bobAcc = (await accountService.getAccountsForUser(bob))[0];

    console.log('1. Executing sequence of financial operations (Deposit -> Transfer -> Withdraw)...');
    await ledgerService.deposit({
        accountId: aliceAcc.id,
        amount: 50000, // +$500 -> $1500
        idempotencyKey: 'ledger_dep_1',
        description: 'Client Invoice',
        actor: alice
    });

    await ledgerService.transfer({
        sourceAccountId: aliceAcc.id,
        destinationAccountId: bobAcc.id,
        amount: 30000, // -$300 Alice ($1200), +$300 Bob ($800)
        idempotencyKey: 'ledger_xfer_1',
        description: 'Contractor Payout',
        actor: alice
    });

    await ledgerService.withdraw({
        accountId: bobAcc.id,
        amount: 10000, // -$100 Bob ($700)
        idempotencyKey: 'ledger_wdl_1',
        description: 'ATM Cash',
        actor: bob
    });

    console.log('2. Checking double-entry invariant per transaction (Sum DEBIT == Sum CREDIT)...');
    const imbalancedTx = await db.all(`
        SELECT transaction_id,
               SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) as debits,
               SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) as credits
        FROM ledger_entries
        GROUP BY transaction_id
        HAVING debits != credits
    `);
    assert.strictEqual(imbalancedTx.length, 0, 'Every transaction must have balanced DEBIT and CREDIT legs');

    console.log('3. Checking global conservation equation...');
    const conservation = await ledgerService.verifyConservation();
    assert.strictEqual(conservation.is_valid, true, 'System ledger conservation must be valid');
    assert.strictEqual(conservation.balance_stats.total_customer_balances, 190000, 'Customer total must equal $1,900.00');
    console.log(`✓ Conservation valid: Debits=${conservation.ledger_stats.total_debits}, Credits=${conservation.ledger_stats.total_credits}`);

    console.log('4. Verifying Alice account statement running balance calculation...');
    const aliceStatement = await accountService.getAccountStatement(aliceAcc.id, alice);
    assert.strictEqual(aliceStatement.account.balance, 120000);
    const latestEntry = aliceStatement.statement_entries[aliceStatement.statement_entries.length - 1];
    assert.strictEqual(latestEntry.running_balance, 120000, 'Latest statement running balance must match current account balance');

    await db.close();
    console.log('✓ PASS: Double-entry invariance & conservation strictly hold!');
}

module.exports = { testLedger };
