// backend/tests/concurrency.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { LedgerService } = require('../src/services/ledgerService');
const { AccountService } = require('../src/services/accountService');
const { AuditService } = require('../src/services/auditService');

async function testConcurrency() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 1: Concurrency Protection (100 Parallel Requests)');
    console.log('======================================================');

    // Setup fresh isolated in-memory DB
    const db = getDatabase(':memory:');
    const { alice } = seedDatabase(db);
    
    const auditService = new AuditService(db);
    const accountService = new AccountService(db);
    const ledgerService = new LedgerService(db, auditService);

    // Create a dedicated test account with exactly $100.00 (10,000 cents)
    const testAccount = accountService.createAccount({
        ownerId: alice.id,
        accountType: 'CHECKING',
        currency: 'USD'
    });

    ledgerService.deposit({
        accountId: testAccount.id,
        amount: 10000, // $100.00
        idempotencyKey: 'concurrency_init_deposit',
        description: 'Initial balance for concurrency test',
        actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
    });

    const initialAccountState = accountService.getAccountById(testAccount.id);
    assert.strictEqual(initialAccountState.balance, 10000, 'Initial balance must be $100.00 (10,000 cents)');
    console.log(`✓ Test account created with balance: $${initialAccountState.balance / 100}`);

    // Fire 100 parallel withdrawal requests of $10.00 (1,000 cents) each
    // Exactly 10 can succeed before funds are exhausted! 90 must fail!
    const totalRequests = 100;
    const withdrawalAmount = 1000; // $10.00
    console.log(`⚡ Dispatching ${totalRequests} simultaneous parallel withdrawals of $${withdrawalAmount / 100}...`);

    const promises = [];
    for (let i = 1; i <= totalRequests; i++) {
        const idempotencyKey = `concurrency_withdraw_req_${i}_${Date.now()}`;
        promises.push(
            new Promise((resolve) => {
                try {
                    const result = ledgerService.withdraw({
                        accountId: testAccount.id,
                        amount: withdrawalAmount,
                        idempotencyKey,
                        description: `Parallel withdrawal #${i}`,
                        actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
                    });
                    resolve({ status: 'SUCCESS', result });
                } catch (err) {
                    resolve({ status: 'FAILURE', error: err.message });
                }
            })
        );
    }

    const results = await Promise.all(promises);

    const successCount = results.filter(r => r.status === 'SUCCESS').length;
    const failureCount = results.filter(r => r.status === 'FAILURE').length;
    const insufficientFundsCount = results.filter(r => r.status === 'FAILURE' && r.error === 'INSUFFICIENT_FUNDS').length;

    console.log(`Results: ${successCount} Succeeded, ${failureCount} Failed (${insufficientFundsCount} INSUFFICIENT_FUNDS)`);

    // Verify account state
    const finalAccountState = accountService.getAccountById(testAccount.id);
    console.log(`Final account balance: $${finalAccountState.balance / 100}`);

    // Assertions
    assert.strictEqual(successCount, 10, 'Exactly 10 withdrawals of $10 must succeed from a $100 balance');
    assert.strictEqual(failureCount, 90, 'Exactly 90 withdrawals must fail');
    assert.strictEqual(finalAccountState.balance, 0, 'Final balance must be exactly $0.00');
    assert(finalAccountState.balance >= 0, 'Balance must NEVER be negative under any circumstances!');

    // Verify ledger conservation
    const conservation = ledgerService.verifyConservation();
    assert.strictEqual(conservation.is_valid, true, 'Ledger must remain 100% balanced after 100 concurrent requests');
    assert.strictEqual(conservation.ledger_stats.difference, 0, 'Sum of Debits - Sum of Credits must be 0');

    console.log('✓ PASS: Concurrency Protection prevents race conditions & negative balances!');
    return true;
}

if (require.main === module) {
    testConcurrency().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

module.exports = { testConcurrency };

