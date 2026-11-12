// backend/src/db/seed.js
const crypto = require('node:crypto');
const { initDatabase } = require('./database');
const { hashPassword } = require('../services/authService');
const { AccountService } = require('../services/accountService');
const { LedgerService } = require('../services/ledgerService');
const { AuditService } = require('../services/auditService');
const config = require('../config');

function resolveSeedPasswords(overrides = {}) {
    const pick = (overrideVal, envKey) =>
        overrideVal ||
        process.env[envKey] ||
        `Gen-${crypto.randomBytes(6).toString('hex')}!9`;

    return {
        admin: pick(overrides.admin, 'SEED_ADMIN_PASSWORD'),
        auditor: pick(overrides.auditor, 'SEED_AUDITOR_PASSWORD'),
        alice: pick(overrides.alice, 'SEED_ALICE_PASSWORD'),
        bob: pick(overrides.bob, 'SEED_BOB_PASSWORD'),
        charlie: pick(overrides.charlie, 'SEED_CHARLIE_PASSWORD')
    };
}

async function seedDatabase(dbOrPath = config.DB_PATH, options = {}) {
    const db = (typeof dbOrPath === 'object' && dbOrPath !== null)
        ? dbOrPath
        : await initDatabase(dbOrPath);

    const passwords = resolveSeedPasswords(options.passwords || {});
    const quiet = Boolean(options.quiet);
    const log = (...args) => { if (!quiet) console.log(...args); };

    const auditService = new AuditService(db);
    const accountService = new AccountService(db);
    const ledgerService = new LedgerService(db, auditService);

    log('--- Initializing Database Seed ---');

    // 1. Always ensure System Root User & Clearing Vault Account exist
    const existingSystem = await db.get('SELECT id FROM users WHERE id = ?', config.SYSTEM_USER_ID);
    if (!existingSystem) {
        const { hash, salt } = hashPassword(crypto.randomBytes(32).toString('hex'));
        await db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'system_clearing_root', 'system@ledgerline.internal', ?, ?, 'ADMIN', 'ACTIVE')
        `, config.SYSTEM_USER_ID, hash, salt);
    }

    const existingClearing = await db.get('SELECT id FROM accounts WHERE id = ?', config.SYSTEM_CLEARING_ACCOUNT_ID);
    if (!existingClearing) {
        await db.run(`
            INSERT INTO accounts (id, account_number, owner_id, account_type, currency, balance, status)
            VALUES (?, 'VAULT-000000', ?, 'SYSTEM_CLEARING', 'USD', 0, 'ACTIVE')
        `, config.SYSTEM_CLEARING_ACCOUNT_ID, config.SYSTEM_USER_ID);
    }

    // In production, only seed demo personas when explicitly enabled
    if (options.skipDemoUsers || (!config.SEED_DEMO_USERS && !options.forceDemoUsers)) {
        log('--- System Clearing Vault Ready (Demo Personas Skipped in Production) ---');
        return { db };
    }

    // 2. Administrator
    let admin = await db.get("SELECT id, username FROM users WHERE username = 'admin'");
    if (!admin) {
        const { hash, salt } = hashPassword(passwords.admin);
        admin = { id: 'usr_admin_default', username: 'admin' };
        await db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'admin', 'admin@ledgerline.io', ?, ?, 'ADMIN', 'ACTIVE')
        `, admin.id, hash, salt);
        log(`✓ Admin seeded: admin / ${passwords.admin}`);
    }

    // 3. Auditor
    let auditor = await db.get("SELECT id, username FROM users WHERE username = 'auditor'");
    if (!auditor) {
        const { hash, salt } = hashPassword(passwords.auditor);
        auditor = { id: 'usr_auditor_default', username: 'auditor' };
        await db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'auditor', 'auditor@ledgerline.io', ?, ?, 'AUDITOR', 'ACTIVE')
        `, auditor.id, hash, salt);
        log(`✓ Auditor seeded: auditor / ${passwords.auditor}`);
    }

    // 4. Account Holder 1: Alice ($1,000.00)
    let alice = await db.get("SELECT id, username FROM users WHERE username = 'alice'");
    if (!alice) {
        const { hash, salt } = hashPassword(passwords.alice);
        alice = { id: 'usr_alice_default', username: 'alice' };
        await db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'alice', 'alice@example.com', ?, ?, 'ACCOUNT_HOLDER', 'ACTIVE')
        `, alice.id, hash, salt);

        const aliceAccount = await accountService.createAccount({
            ownerId: alice.id,
            accountType: 'CHECKING',
            currency: 'USD'
        });

        await ledgerService.deposit({
            accountId: aliceAccount.id,
            amount: 100000,
            idempotencyKey: 'seed_init_deposit_alice_1000',
            description: 'Initial funding deposit',
            actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
        });
        log(`✓ Alice seeded: alice / ${passwords.alice} ($1,000.00, ${aliceAccount.account_number})`);
    }

    // 5. Account Holder 2: Bob ($500.00)
    let bob = await db.get("SELECT id, username FROM users WHERE username = 'bob'");
    if (!bob) {
        const { hash, salt } = hashPassword(passwords.bob);
        bob = { id: 'usr_bob_default', username: 'bob' };
        await db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'bob', 'bob@example.com', ?, ?, 'ACCOUNT_HOLDER', 'ACTIVE')
        `, bob.id, hash, salt);

        const bobAccount = await accountService.createAccount({
            ownerId: bob.id,
            accountType: 'CHECKING',
            currency: 'USD'
        });

        await ledgerService.deposit({
            accountId: bobAccount.id,
            amount: 50000,
            idempotencyKey: 'seed_init_deposit_bob_500',
            description: 'Initial funding deposit',
            actor: { userId: bob.id, username: bob.username, role: 'ACCOUNT_HOLDER' }
        });
        log(`✓ Bob seeded: bob / ${passwords.bob} ($500.00, ${bobAccount.account_number})`);
    }

    // 6. Pending Onboarding User: Charlie
    let charlie = await db.get("SELECT id, username FROM users WHERE username = 'charlie'");
    if (!charlie) {
        const { hash, salt } = hashPassword(passwords.charlie);
        charlie = { id: 'usr_charlie_pending', username: 'charlie' };
        await db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, 'charlie', 'charlie@example.com', ?, ?, 'ACCOUNT_HOLDER', 'PENDING_APPROVAL')
        `, charlie.id, hash, salt);
        log(`✓ Pending User seeded: charlie / ${passwords.charlie} (PENDING_APPROVAL)`);
    }

    const conservation = await ledgerService.verifyConservation();
    log('✓ Ledger conservation verification:', conservation.is_valid ? 'PERFECTLY BALANCED' : 'IMBALANCE DETECTED');
    log(`  Total Debits: $${conservation.ledger_stats.total_debits / 100} | Total Credits: $${conservation.ledger_stats.total_credits / 100}`);
    log(`  Clearing Vault: $${conservation.balance_stats.clearing_vault_balance / 100} | Total Customer: $${conservation.balance_stats.total_customer_balances / 100}`);
    log('--- Seed Completed Successfully ---');

    return { db, admin, auditor, alice, bob, charlie, passwords };
}

/**
 * Auto-seed on first startup when database has no platform users.
 */
async function ensureSeeded(dbOrPath = config.DB_PATH, options = {}) {
    const db = (typeof dbOrPath === 'object' && dbOrPath !== null)
        ? dbOrPath
        : await initDatabase(dbOrPath);

    const row = await db.get('SELECT COUNT(*) as count FROM users WHERE id != ?', config.SYSTEM_USER_ID);
    if (Number(row.count) === 0) {
        return seedDatabase(db, options);
    }
    return null;
}

/**
 * Reset transactional and account data back to baseline while strictly preserving `audit_logs`.
 */
async function resetAndSeedDatabase(dbOrPath = config.DB_PATH, actor = null, options = {}) {
    const db = (typeof dbOrPath === 'object' && dbOrPath !== null)
        ? dbOrPath
        : await initDatabase(dbOrPath);

    await db.withTransaction(async (txDb) => {
        await txDb.run('DELETE FROM revoked_tokens');
        await txDb.run('DELETE FROM ledger_entries');
        await txDb.run('DELETE FROM transactions');
        await txDb.run('DELETE FROM idempotency_keys');
        await txDb.run('DELETE FROM accounts');
        await txDb.run('DELETE FROM users');
    });

    const seeded = await seedDatabase(db, { ...options, forceDemoUsers: true });
    const auditService = new AuditService(db);
    await auditService.record({
        actorId: actor?.userId || config.SYSTEM_USER_ID,
        actorUsername: actor?.username || 'system',
        actorRole: actor?.role || 'ADMIN',
        action: 'DEMO_DATABASE_RESET',
        entityType: 'SYSTEM',
        details: { note: 'Demo accounts and balances reset; audit_logs preserved.' },
        status: 'SUCCESS'
    });

    return seeded;
}

if (require.main === module) {
    seedDatabase(config.DB_PATH, { forceDemoUsers: true })
        .then(async ({ db }) => {
            await db.close();
            process.exit(0);
        })
        .catch((err) => {
            console.error('Seed failed:', err);
            process.exit(1);
        });
}

module.exports = {
    seedDatabase,
    ensureSeeded,
    resetAndSeedDatabase
};
