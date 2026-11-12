// backend/tests/security.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { AuthService } = require('../src/services/authService');
const { AccountService } = require('../src/services/accountService');
const { LedgerService } = require('../src/services/ledgerService');
const { AuditService } = require('../src/services/auditService');
const { AdminService } = require('../src/services/adminService');
const { TEST_PASSWORDS } = require('./testFixtures');

async function testSecurity() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 4: Security, RBAC & Ownership Protection');
    console.log('======================================================');

    const db = getDatabase(':memory:', true);
    const seeded = await seedDatabase(db, { passwords: TEST_PASSWORDS, forceDemoUsers: true });

    const auditService = new AuditService(db);
    const authService = new AuthService(db);
    const accountService = new AccountService(db, auditService);
    const ledgerService = new LedgerService(db, auditService);
    const adminService = new AdminService(db, auditService, accountService);

    const alice = { userId: seeded.alice.id, username: 'alice', role: 'ACCOUNT_HOLDER' };
    const bob = { userId: seeded.bob.id, username: 'bob', role: 'ACCOUNT_HOLDER' };
    const admin = { userId: seeded.admin.id, username: 'admin', role: 'ADMIN' };

    const bobAcc = (await accountService.getAccountsForUser(bob))[0];

    console.log('1. Testing Horizontal Privilege Escalation (Alice withdrawing from Bob)...');
    let errMsg = null;
    try {
        await ledgerService.withdraw({
            accountId: bobAcc.id,
            amount: 1000,
            idempotencyKey: 'hack_attempt_1',
            actor: alice
        });
    } catch (err) {
        errMsg = err.message;
    }
    assert.strictEqual(errMsg, 'UNAUTHORIZED_ACCOUNT_ACCESS', 'Alice must be blocked from withdrawing from Bob account');
    console.log('✓ Unauthorized withdrawal blocked cleanly');

    console.log('2. Testing Unauthorized Statement Access (Alice reading Bob statement)...');
    let stmtErr = null;
    try {
        await accountService.getAccountStatement(bobAcc.id, alice);
    } catch (err) {
        stmtErr = err.message;
    }
    assert.strictEqual(stmtErr, 'UNAUTHORIZED_ACCOUNT_ACCESS');
    console.log('✓ Unauthorized statement read blocked cleanly');

    console.log('3. Testing PENDING_APPROVAL user login block & Admin Activation (FR-6 / FR-8)...');
    let pendingErr = null;
    try {
        await authService.login({ username: 'charlie', password: TEST_PASSWORDS.charlie });
    } catch (err) {
        pendingErr = err.message;
    }
    assert.strictEqual(pendingErr, 'ACCOUNT_PENDING_APPROVAL', 'Pending user cannot log in prior to admin approval');

    await adminService.activateUser(seeded.charlie.id, admin);
    const charlieLogin = await authService.login({ username: 'charlie', password: TEST_PASSWORDS.charlie });
    assert.ok(charlieLogin.token, 'Activated user should log in successfully');
    console.log('✓ Pending login blocked -> Admin approved -> Charlie logged in');

    console.log('4. Testing Admin Deactivation blocks subsequent login...');
    await adminService.deactivateUser(seeded.charlie.id, admin);
    let deactivatedErr = null;
    try {
        await authService.login({ username: 'charlie', password: TEST_PASSWORDS.charlie });
    } catch (err) {
        deactivatedErr = err.message;
    }
    assert.strictEqual(deactivatedErr, 'ACCOUNT_DEACTIVATED');
    console.log('✓ Deactivated user blocked from logging in');

    await db.close();
    console.log('✓ PASS: RBAC, ownership isolation & onboarding security verified!');
}

module.exports = { testSecurity };
