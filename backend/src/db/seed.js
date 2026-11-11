// backend/src/db/seed.js
const { getDatabase } = require('./database');
const { AuthService, hashPassword } = require('../services/authService');
const { AccountService } = require('../services/accountService');
const { LedgerService } = require('../services/ledgerService');
const { AuditService } = require('../services/auditService');
const config = require('../config');

function seedDatabase(dbPath = config.DB_PATH) {
    const db = getDatabase(dbPath);
    const auditService = new AuditService(db);
    const authService = new AuthService(db);
    const accountService = new AccountService(db);
    const ledgerService = new LedgerService(db, auditService);

    console.log('--- Initializing Database Seed ---');

    // 1. Create System Root User & Clearing Vault Account
    const existingSystem = db.prepare('SELECT id FROM users WHERE id = ?').get(config.SYSTEM_USER_ID);
    if (!existingSystem) {
        const { hash, salt } = hashPassword('system_root_internal_key_' + Math.random());
        db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'system_clearing_root', 'system@ledgerline.internal', ?, ?, 'ADMIN', 'ACTIVE')
        `).run(config.SYSTEM_USER_ID, hash, salt);
    }

    const existingClearing = db.prepare('SELECT id FROM accounts WHERE id = ?').get(config.SYSTEM_CLEARING_ACCOUNT_ID);
    if (!existingClearing) {
        db.prepare(`
            INSERT INTO accounts (id, account_number, owner_id, account_type, currency, balance, status)
            VALUES (?, 'VAULT-000000', ?, 'SYSTEM_CLEARING', 'USD', 0, 'ACTIVE')
        `).run(config.SYSTEM_CLEARING_ACCOUNT_ID, config.SYSTEM_USER_ID);
    }

    // 2. First Admin (FR-4)
    let admin = db.prepare("SELECT id, username FROM users WHERE username = 'admin'").get();
    if (!admin) {
        const { hash, salt } = hashPassword('AdminPassword123!');
        admin = { id: 'usr_admin_default', username: 'admin' };
        db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'admin', 'admin@ledgerline.io', ?, ?, 'ADMIN', 'ACTIVE')
        `).run(admin.id, hash, salt);
        console.log('✓ Admin seeded: admin / AdminPassword123!');
    }

    // 3. Auditor (FR-1)
    let auditor = db.prepare("SELECT id, username FROM users WHERE username = 'auditor'").get();
    if (!auditor) {
        const { hash, salt } = hashPassword('AuditorPassword123!');
        auditor = { id: 'usr_auditor_default', username: 'auditor' };
        db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'auditor', 'auditor@ledgerline.io', ?, ?, 'AUDITOR', 'ACTIVE')
        `).run(auditor.id, hash, salt);
        console.log('✓ Auditor seeded: auditor / AuditorPassword123!');
    }

    // 4. Account Holder 1: Alice
    let alice = db.prepare("SELECT id, username FROM users WHERE username = 'alice'").get();
    let aliceAccount;
    if (!alice) {
        const { hash, salt } = hashPassword('AlicePassword123!');
        alice = { id: 'usr_alice_default', username: 'alice' };
        db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'alice', 'alice@example.com', ?, ?, 'ACCOUNT_HOLDER', 'ACTIVE')
        `).run(alice.id, hash, salt);

        aliceAccount = accountService.createAccount({
            ownerId: alice.id,
            accountType: 'CHECKING',
            currency: 'USD'
        });

        // Deposit initial balance: $1,000.00 (100,000 cents) via double-entry ledger!
        ledgerService.deposit({
            accountId: aliceAccount.id,
            amount: 100000,
            idempotencyKey: 'seed_init_deposit_alice_1000',
            description: 'Initial funding deposit',
            actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
        });
        console.log(`✓ Alice seeded: alice / AlicePassword123! with balance $1,000.00 (${aliceAccount.account_number})`);
    }

    // 5. Account Holder 2: Bob
    let bob = db.prepare("SELECT id, username FROM users WHERE username = 'bob'").get();
    let bobAccount;
    if (!bob) {
        const { hash, salt } = hashPassword('BobPassword123!');
        bob = { id: 'usr_bob_default', username: 'bob' };
        db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'bob', 'bob@example.com', ?, ?, 'ACCOUNT_HOLDER', 'ACTIVE')
        `).run(bob.id, hash, salt);

        bobAccount = accountService.createAccount({
            ownerId: bob.id,
            accountType: 'CHECKING',
            currency: 'USD'
        });

        // Deposit initial balance: $500.00 (50,000 cents) via double-entry ledger!
        ledgerService.deposit({
            accountId: bobAccount.id,
            amount: 50000,
            idempotencyKey: 'seed_init_deposit_bob_500',
            description: 'Initial funding deposit',
            actor: { userId: bob.id, username: bob.username, role: 'ACCOUNT_HOLDER' }
        });
        console.log(`✓ Bob seeded: bob / BobPassword123! with balance $500.00 (${bobAccount.account_number})`);
    }

    // 6. Pending Onboarding User: Charlie (for FR-7 Admin Onboarding Workflow demo)
    let charlie = db.prepare("SELECT id, username FROM users WHERE username = 'charlie'").get();
    if (!charlie) {
        const { hash, salt } = hashPassword('CharliePassword123!');
        charlie = { id: 'usr_charlie_pending', username: 'charlie' };
        db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'charlie', 'charlie@example.com', ?, ?, 'ACCOUNT_HOLDER', 'PENDING_APPROVAL')
        `).run(charlie.id, hash, salt);
        console.log('✓ Pending User seeded: charlie (status: PENDING_APPROVAL for admin review)');
    }

    // Verify initial ledger conservation
    const conservation = ledgerService.verifyConservation();
    console.log('✓ Ledger conservation verification:', conservation.is_valid ? 'PERFECTLY BALANCED' : 'IMBALANCE DETECTED');
    console.log(`  Total Debits: $${conservation.ledger_stats.total_debits / 100} | Total Credits: $${conservation.ledger_stats.total_credits / 100}`);
    console.log(`  Clearing Vault: $${conservation.balance_stats.clearing_vault_balance / 100} | Total Customer: $${conservation.balance_stats.total_customer_balances / 100}`);
    console.log('--- Seed Completed Successfully ---');

    return { db, admin, auditor, alice, bob, charlie };
}

if (require.main === module) {
    seedDatabase();
}

module.exports = { seedDatabase };
