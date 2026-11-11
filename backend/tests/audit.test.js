// backend/tests/audit.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { AuditService } = require('../src/services/auditService');

async function testAudit() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 5: Append-Only Audit Trail & Immutability');
    console.log('======================================================');

    const db = getDatabase(':memory:');
    seedDatabase(':memory:');
    const auditService = new AuditService(db);

    console.log('1. Recording audit event...');
    const auditId = auditService.record({
        actorId: 'usr_test_actor',
        actorUsername: 'test_user',
        actorRole: 'ACCOUNT_HOLDER',
        action: 'TEST_AUDIT_ACTION',
        entityType: 'TEST',
        entityId: 'ent_123',
        details: { note: 'Security test' },
        ipAddress: '192.168.1.100',
        status: 'SUCCESS'
    });
    assert(auditId, 'Audit event successfully recorded');
    console.log(`✓ Audit event recorded with ID: ${auditId}`);

    console.log('2. Attempting SQL UPDATE on audit_logs (must be blocked by DB Trigger)...');
    let updateBlocked = false;
    try {
        db.prepare("UPDATE audit_logs SET action = 'TAMPERED_ACTION' WHERE id = ?").run(auditId);
    } catch (err) {
        updateBlocked = true;
        assert(err.message.includes('ILLEGAL_OPERATION') || err.message.includes('append-only'));
        console.log(`✓ Database trigger successfully aborted UPDATE attempt: ${err.message}`);
    }
    assert(updateBlocked, 'Direct SQL UPDATE on audit_logs must be rejected by trigger');

    console.log('3. Attempting SQL DELETE on audit_logs (must be blocked by DB Trigger)...');
    let deleteBlocked = false;
    try {
        db.prepare("DELETE FROM audit_logs WHERE id = ?").run(auditId);
    } catch (err) {
        deleteBlocked = true;
        assert(err.message.includes('ILLEGAL_OPERATION') || err.message.includes('append-only'));
        console.log(`✓ Database trigger successfully aborted DELETE attempt: ${err.message}`);
    }
    assert(deleteBlocked, 'Direct SQL DELETE on audit_logs must be rejected by trigger');

    console.log('4. Verifying record contents remain unchanged...');
    const record = db.prepare('SELECT action FROM audit_logs WHERE id = ?').get(auditId);
    assert.strictEqual(record.action, 'TEST_AUDIT_ACTION', 'Audit record content must remain strictly unmodified');

    console.log('✓ PASS: Audit trail is provably immutable and tamper-proof!');
    return true;
}

if (require.main === module) {
    testAudit().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

module.exports = { testAudit };
