// backend/tests/audit.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { AuditService } = require('../src/services/auditService');
const { TEST_PASSWORDS } = require('./testFixtures');

async function testAudit() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 5: Append-Only Audit Trail & Immutability');
    console.log('======================================================');

    const db = getDatabase(':memory:', true);
    await seedDatabase(db, { passwords: TEST_PASSWORDS, forceDemoUsers: true });

    const auditService = new AuditService(db);

    console.log('1. Recording audit event...');
    const auditId = await auditService.record({
        actorId: 'usr_admin_default',
        actorUsername: 'admin',
        actorRole: 'ADMIN',
        action: 'COMPLIANCE_CHECK',
        entityType: 'SYSTEM',
        details: { verified: true },
        status: 'SUCCESS'
    });
    assert.ok(auditId && auditId.startsWith('aud_'), 'Audit ID must be created');
    console.log(`✓ Audit event recorded with ID: ${auditId}`);

    console.log('2. Attempting SQL UPDATE on audit_logs (must be blocked by DB Trigger)...');
    let updateRejected = false;
    try {
        await db.run("UPDATE audit_logs SET status = 'TAMPERED' WHERE id = ?", auditId);
    } catch (err) {
        updateRejected = true;
    }
    assert.strictEqual(updateRejected, true, 'Direct SQL UPDATE on audit_logs must be rejected by trigger');
    console.log('✓ SQL UPDATE blocked by append-only immutability trigger');

    console.log('3. Attempting SQL DELETE on audit_logs (must be blocked by DB Trigger)...');
    let deleteRejected = false;
    try {
        await db.run('DELETE FROM audit_logs WHERE id = ?', auditId);
    } catch (err) {
        deleteRejected = true;
    }
    assert.strictEqual(deleteRejected, true, 'Direct SQL DELETE on audit_logs must be rejected by trigger');
    console.log('✓ SQL DELETE blocked by append-only immutability trigger');

    console.log('4. Verifying filtered audit log retrieval & SHA-256 hash-chain integrity...');
    const logs = await auditService.getLogs({ action: 'COMPLIANCE_CHECK', search: 'verified' });
    assert.strictEqual(logs.logs.length, 1);
    assert.strictEqual(logs.logs[0].id, auditId);
    assert.ok(logs.logs[0].entry_hash, 'Audit row must include cryptographic entry_hash');

    const chain = await auditService.verifyHashChain();
    assert.strictEqual(chain.valid, true, 'Audit SHA-256 hash chain must verify cleanly');
    assert.ok(chain.verifiedEntries >= 1);

    await db.close();
    console.log('✓ PASS: Audit trail is strictly append-only, hash-chained & tamper-resistant!');
}

module.exports = { testAudit };
