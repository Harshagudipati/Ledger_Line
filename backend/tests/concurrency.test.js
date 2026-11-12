// backend/tests/concurrency.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { AccountService } = require('../src/services/accountService');
const { LedgerService } = require('../src/services/ledgerService');
const { AuditService } = require('../src/services/auditService');
const { TEST_PASSWORDS } = require('./testFixtures');

async function testConcurrency() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 1: Concurrency Protection (100 Parallel Requests)');
    console.log('======================================================');

    const db = getDatabase(':memory:', true);
    const seeded = await seedDatabase(db, { passwords: TEST_PASSWORDS, forceDemoUsers: true });

    const auditService = new AuditService(db);
    const accountService = new AccountService(db, auditService);
    const ledgerService = new LedgerService(db, auditService);

    const alice = { userId: seeded.alice.id, username: 'alice', role: 'ACCOUNT_HOLDER' };
    const testAcc = await accountService.createAccount({ ownerId: alice.userId, accountType: 'CHECKING' });

    await ledgerService.deposit({
        accountId: testAcc.id,
        amount: 10000, // $100.00
        idempotencyKey: 'concurrency_seed_dep',
        actor: alice
    });

    const initialAccount = await accountService.getAccountById(testAcc.id);
    assert.strictEqual(initialAccount.balance, 10000, 'Test account must start at $100.00');
    console.log(`✓ Test account created with balance: $${(initialAccount.balance / 100).toFixed(2)}`);

    const TOTAL_PARALLEL = 100;
    const WITHDRAW_AMOUNT = 1000; // $10.00
    console.log(`⚡ Dispatching ${TOTAL_PARALLEL} simultaneous parallel withdrawals of $10...`);

    const promises = Array.from({ length: TOTAL_PARALLEL }, (_, i) =>
        ledgerService.withdraw({
            accountId: testAcc.id,
            amount: WITHDRAW_AMOUNT,
            idempotencyKey: `parallel_wdl_${i}`,
            description: `Parallel withdrawal #${i}`,
            actor: alice
        }).then(res => ({ ok: true, res }))
          .catch(err => ({ ok: false, error: err.message }))
    );

    const outcomes = await Promise.all(promises);
    const succeeded = outcomes.filter(o => o.ok);
    const failed = outcomes.filter(o => !o.ok);

    console.log(`Results: ${succeeded.length} Succeeded, ${failed.length} Failed (${failed.filter(f => f.error === 'INSUFFICIENT_FUNDS').length} INSUFFICIENT_FUNDS)`);

    assert.strictEqual(succeeded.length, 10, 'Exactly 10 withdrawals of $10 should succeed from $100 balance');
    assert.strictEqual(failed.length, 90, 'Exactly 90 withdrawals must fail');
    assert.ok(failed.every(f => f.error === 'INSUFFICIENT_FUNDS'), 'All failed attempts must fail with INSUFFICIENT_FUNDS');

    const finalAccount = await accountService.getAccountById(testAcc.id);
    console.log(`Final account balance: $${(finalAccount.balance / 100).toFixed(2)}`);
    assert.strictEqual(finalAccount.balance, 0, 'Final account balance must be exactly 0 (never negative)');

    const conservation = await ledgerService.verifyConservation();
    assert.strictEqual(conservation.is_valid, true, 'Ledger conservation must remain intact after concurrent load');

    await db.close();
    console.log('✓ PASS: Concurrency Protection prevents race conditions & negative balances!');
}

module.exports = { testConcurrency };
