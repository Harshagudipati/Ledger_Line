// backend/tests/idempotency.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { LedgerService } = require('../src/services/ledgerService');
const { AccountService } = require('../src/services/accountService');
const { AuditService } = require('../src/services/auditService');

async function testIdempotency() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 2: Idempotency Protection');
    console.log('======================================================');

    const db = getDatabase(':memory:');
    const { alice, bob } = seedDatabase(':memory:');
    
    const auditService = new AuditService(db);
    const accountService = new AccountService(db);
    const ledgerService = new LedgerService(db, auditService);

    const aliceAccounts = accountService.getAccountsForUser({ userId: alice.id, role: 'ACCOUNT_HOLDER' });
    const bobAccounts = accountService.getAccountsForUser({ userId: bob.id, role: 'ACCOUNT_HOLDER' });

    const aliceAcc = aliceAccounts[0];
    const bobAcc = bobAccounts[0];

    const initialAliceBalance = aliceAcc.balance;
    const initialBobBalance = bobAcc.balance;

    const testIdempotencyKey = 'idempotent_tx_test_key_abc_123';
    const transferAmount = 2500; // $25.00

    console.log(`1. Executing transfer with key: ${testIdempotencyKey}...`);
    const firstCall = ledgerService.transfer({
        sourceAccountId: aliceAcc.id,
        destinationAccountId: bobAcc.id,
        amount: transferAmount,
        idempotencyKey: testIdempotencyKey,
        description: 'Test transfer for idempotency',
        actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
    });

    assert.strictEqual(firstCall.type, 'TRANSFER');
    assert.strictEqual(firstCall.amount, transferAmount);
    assert.strictEqual(firstCall.isCached, undefined);
    console.log(`✓ First transfer completed: Tx ID = ${firstCall.transactionId}`);

    const midAliceBalance = accountService.getAccountById(aliceAcc.id).balance;
    const midBobBalance = accountService.getAccountById(bobAcc.id).balance;
    assert.strictEqual(midAliceBalance, initialAliceBalance - transferAmount);
    assert.strictEqual(midBobBalance, initialBobBalance + transferAmount);

    console.log(`2. Replaying exact same request with key: ${testIdempotencyKey}...`);
    const secondCall = ledgerService.transfer({
        sourceAccountId: aliceAcc.id,
        destinationAccountId: bobAcc.id,
        amount: transferAmount,
        idempotencyKey: testIdempotencyKey,
        description: 'Test transfer for idempotency',
        actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
    });

    assert.strictEqual(secondCall.isCached, true, 'Second call must return cached result');
    assert.strictEqual(secondCall.transactionId, firstCall.transactionId, 'Transaction ID must match original');
    assert.strictEqual(secondCall.amount, firstCall.amount);
    console.log(`✓ Replay safely returned cached response. No second transaction created!`);

    // Verify balances did NOT change twice
    const finalAliceBalance = accountService.getAccountById(aliceAcc.id).balance;
    const finalBobBalance = accountService.getAccountById(bobAcc.id).balance;
    assert.strictEqual(finalAliceBalance, midAliceBalance, 'Alice balance must not be debited twice');
    assert.strictEqual(finalBobBalance, midBobBalance, 'Bob balance must not be credited twice');

    console.log(`3. Replaying key with modified payload (should be rejected)...`);
    let payloadMismatchCaught = false;
    try {
        ledgerService.transfer({
            sourceAccountId: aliceAcc.id,
            destinationAccountId: bobAcc.id,
            amount: 9999, // Changed amount!
            idempotencyKey: testIdempotencyKey,
            description: 'Tampered transfer',
            actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
        });
    } catch (err) {
        payloadMismatchCaught = true;
        assert.strictEqual(err.message, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
        console.log(`✓ Tampered payload with reused key successfully rejected: ${err.message}`);
    }
    assert(payloadMismatchCaught, 'Reusing idempotency key with different payload must fail');

    console.log('✓ PASS: Idempotency strictly guarantees at-most-once execution!');
    return true;
}

if (require.main === module) {
    testIdempotency().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

module.exports = { testIdempotency };
