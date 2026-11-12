// backend/tests/idempotency.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { AccountService } = require('../src/services/accountService');
const { LedgerService } = require('../src/services/ledgerService');
const { AuditService } = require('../src/services/auditService');
const { TEST_PASSWORDS } = require('./testFixtures');

async function testIdempotency() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 2: Idempotency Protection');
    console.log('======================================================');

    const db = getDatabase(':memory:', true);
    const seeded = await seedDatabase(db, { passwords: TEST_PASSWORDS, forceDemoUsers: true });

    const auditService = new AuditService(db);
    const accountService = new AccountService(db, auditService);
    const ledgerService = new LedgerService(db, auditService);

    const aliceActor = { userId: seeded.alice.id, username: 'alice', role: 'ACCOUNT_HOLDER' };
    const aliceAccounts = await accountService.getAccountsForUser(aliceActor);
    const bobAccounts = await accountService.getAccountsForUser({ userId: seeded.bob.id, role: 'ACCOUNT_HOLDER' });

    const aliceAcc = aliceAccounts[0];
    const bobAcc = bobAccounts[0];
    const idempotencyKey = 'idempotent_tx_test_key_abc_123';

    console.log(`1. Executing transfer with key: ${idempotencyKey}...`);
    const first = await ledgerService.transfer({
        sourceAccountId: aliceAcc.id,
        destinationAccountId: bobAcc.id,
        amount: 25000, // $250
        idempotencyKey,
        description: 'Idempotent rent payment',
        actor: aliceActor
    });
    assert.ok(!first.isCached, 'First execution must not be cached');
    assert.strictEqual(first.sourceNewBalance, 75000, 'Alice balance should drop from $1000 to $750');
    assert.strictEqual(first.destinationNewBalance, 75000, 'Bob balance should rise from $500 to $750');
    console.log(`✓ First transfer completed: Tx ID = ${first.transactionId}`);

    console.log(`2. Replaying exact same request with key: ${idempotencyKey}...`);
    const replay = await ledgerService.transfer({
        sourceAccountId: aliceAcc.id,
        destinationAccountId: bobAcc.id,
        amount: 25000,
        idempotencyKey,
        description: 'Idempotent rent payment',
        actor: aliceActor
    });
    assert.strictEqual(replay.isCached, true, 'Replay must return cached result');
    assert.strictEqual(replay.transactionId, first.transactionId, 'Replay must return original transaction ID');

    const aliceAfterReplay = await accountService.getAccountById(aliceAcc.id);
    const bobAfterReplay = await accountService.getAccountById(bobAcc.id);
    assert.strictEqual(aliceAfterReplay.balance, 75000, 'Alice must not be double-debited');
    assert.strictEqual(bobAfterReplay.balance, 75000, 'Bob must not be double-credited');
    console.log('✓ Replay safely returned cached response. No second transaction created!');

    console.log('3. Replaying key with modified payload (should be rejected)...');
    let mismatchErr = null;
    try {
        await ledgerService.transfer({
            sourceAccountId: aliceAcc.id,
            destinationAccountId: bobAcc.id,
            amount: 50000,
            idempotencyKey,
            description: 'Tampered payload',
            actor: aliceActor
        });
    } catch (err) {
        mismatchErr = err.message;
    }
    assert.strictEqual(mismatchErr, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', 'Reusing idempotency key with different payload must reject');
    console.log(`✓ Tampered payload with reused key successfully rejected: ${mismatchErr}`);

    await db.close();
    console.log('✓ PASS: Idempotency strictly guarantees at-most-once execution!');
}

module.exports = { testIdempotency };
