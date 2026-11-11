// backend/tests/security.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { AuthService } = require('../src/services/authService');
const { AccountService } = require('../src/services/accountService');
const { LedgerService } = require('../src/services/ledgerService');
const { AuditService } = require('../src/services/auditService');
const { AdminService } = require('../src/services/adminService');

async function testSecurity() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 4: Security, RBAC & Ownership Protection');
    console.log('======================================================');

    const db = getDatabase(':memory:');
    const { admin, auditor, alice, bob, charlie } = seedDatabase(':memory:');
    
    const auditService = new AuditService(db);
    const authService = new AuthService(db);
    const accountService = new AccountService(db);
    const ledgerService = new LedgerService(db, auditService);
    const adminService = new AdminService(db, auditService, accountService);

    const aliceAcc = accountService.getAccountsForUser({ userId: alice.id, role: 'ACCOUNT_HOLDER' })[0];
    const bobAcc = accountService.getAccountsForUser({ userId: bob.id, role: 'ACCOUNT_HOLDER' })[0];

    console.log('1. Testing FR-3: Account Ownership Protection...');
    // Bob attempts to withdraw from Alice's account!
    let unauthorizedWithdrawalCaught = false;
    try {
        ledgerService.withdraw({
            accountId: aliceAcc.id,
            amount: 5000,
            idempotencyKey: 'unauth_withdraw_1',
            description: 'Theft attempt',
            actor: { userId: bob.id, username: bob.username, role: 'ACCOUNT_HOLDER' }
        });
    } catch (err) {
        unauthorizedWithdrawalCaught = true;
        assert.strictEqual(err.message, 'UNAUTHORIZED_ACCOUNT_ACCESS');
        console.log(`✓ Unauthorized cross-account withdrawal blocked: ${err.message}`);
    }
    assert(unauthorizedWithdrawalCaught, 'User must not be able to withdraw from another users account');

    // Bob attempts to view Alice's account statement!
    let unauthorizedStatementCaught = false;
    try {
        accountService.getAccountStatement(aliceAcc.id, { userId: bob.id, role: 'ACCOUNT_HOLDER' });
    } catch (err) {
        unauthorizedStatementCaught = true;
        assert.strictEqual(err.message, 'UNAUTHORIZED_ACCOUNT_ACCESS');
        console.log(`✓ Unauthorized cross-account statement access blocked: ${err.message}`);
    }
    assert(unauthorizedStatementCaught, 'User must not be able to read another users statement');

    console.log('2. Testing FR-7: Account Onboarding Workflow...');
    // Charlie is PENDING_APPROVAL. Attempting login must be blocked.
    let pendingLoginCaught = false;
    try {
        authService.login({ username: 'charlie', password: 'CharliePassword123!' });
    } catch (err) {
        pendingLoginCaught = true;
        assert.strictEqual(err.message, 'ACCOUNT_PENDING_APPROVAL');
        console.log(`✓ Unactivated user login safely blocked: ${err.message}`);
    }
    assert(pendingLoginCaught, 'Pending user must not be able to log in before admin approval');

    // Admin reviews and activates Charlie
    console.log('  - Admin approves Charlie...');
    const activationResult = adminService.activateUser(charlie.id, {
        userId: admin.id,
        username: admin.username,
        role: 'ADMIN'
    });
    assert.strictEqual(activationResult.status, 'ACTIVE');
    assert(activationResult.initialAccount, 'Initial checking account auto-provisioned upon activation');
    console.log(`✓ Charlie successfully activated with initial account ${activationResult.initialAccount.account_number}`);

    // Now Charlie logs in successfully!
    const charlieLogin = authService.login({ username: 'charlie', password: 'CharliePassword123!' });
    assert(charlieLogin.token, 'Activated user gets JWT token upon login');
    console.log('✓ Charlie logged in successfully with valid JWT token');

    console.log('3. Testing Admin self-deactivation prevention...');
    let selfDeactivateCaught = false;
    try {
        adminService.deactivateUser(admin.id, { userId: admin.id, username: admin.username, role: 'ADMIN' });
    } catch (err) {
        selfDeactivateCaught = true;
        assert.strictEqual(err.message, 'CANNOT_DEACTIVATE_OWN_ADMIN_ACCOUNT');
        console.log(`✓ Admin self-deactivation safely blocked: ${err.message}`);
    }
    assert(selfDeactivateCaught);

    console.log('✓ PASS: Security, RBAC & Ownership checks 100% verified!');
    return true;
}

if (require.main === module) {
    testSecurity().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

module.exports = { testSecurity };

