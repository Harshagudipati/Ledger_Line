// backend/tests/ledger.test.js
const assert = require('node:assert');
const { getDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seed');
const { LedgerService } = require('../src/services/ledgerService');
const { AccountService } = require('../src/services/accountService');
const { AuditService } = require('../src/services/auditService');

async function testLedger() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 3: Double-Entry Ledger & Conservation');
    console.log('======================================================');

    const db = getDatabase(':memory:');
    const { alice, bob } = seedDatabase(db);
    
    const auditService = new AuditService(db);
    const accountService = new AccountService(db);
    const ledgerService = new LedgerService(db, auditService);

    const aliceAcc = accountService.getAccountsForUser({ userId: alice.id, role: 'ACCOUNT_HOLDER' })[0];
    const bobAcc = accountService.getAccountsForUser({ userId: bob.id, role: 'ACCOUNT_HOLDER' })[0];

    console.log('1. Executing sequence of financial operations:');
    // Operation 1: Deposit $200.00 to Alice
    console.log('  - Depositing $200.00 to Alice...');
    ledgerService.deposit({
        accountId: aliceAcc.id,
        amount: 20000,
        idempotencyKey: 'tx_seq_1',
        description: 'Sequence Deposit',
        actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
    });

    // Operation 2: Alice transfers $150.00 to Bob
    console.log('  - Transferring $150.00 from Alice to Bob...');
    ledgerService.transfer({
        sourceAccountId: aliceAcc.id,
        destinationAccountId: bobAcc.id,
        amount: 15000,
        idempotencyKey: 'tx_seq_2',
        description: 'Sequence Transfer',
        actor: { userId: alice.id, username: alice.username, role: 'ACCOUNT_HOLDER' }
    });

    // Operation 3: Bob withdraws $50.00
    console.log('  - Bob withdraws $50.00...');
    ledgerService.withdraw({
        accountId: bobAcc.id,
        amount: 5000,
        idempotencyKey: 'tx_seq_3',
        description: 'Sequence Withdrawal',
        actor: { userId: bob.id, username: bob.username, role: 'ACCOUNT_HOLDER' }
    });

    // Verify all individual transactions have sum(debit) == sum(credit)
    const unbalancedCount = db.prepare(`
        SELECT COUNT(*) as count FROM (
            SELECT transaction_id, 
                   SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) as diff
            FROM ledger_entries
            GROUP BY transaction_id
            HAVING diff != 0
        )
    `).get().count;
    assert.strictEqual(unbalancedCount, 0, 'Every individual transaction must produce equal debits and credits');
    console.log('✓ Every transaction in ledger has Debits = Credits (Zero-Sum Invariance)');

    // Call verifyConservation
    const conservation = ledgerService.verifyConservation();
    console.log('2. System-wide conservation verification:');
    console.log(`  - Total Debits:      $${conservation.ledger_stats.total_debits / 100}`);
    console.log(`  - Total Credits:     $${conservation.ledger_stats.total_credits / 100}`);
    console.log(`  - Total Difference:  $${conservation.ledger_stats.difference / 100}`);
    console.log(`  - Customer Balances: $${conservation.balance_stats.total_customer_balances / 100}`);
    console.log(`  - Clearing Vault:    $${conservation.balance_stats.clearing_vault_balance / 100}`);

    assert.strictEqual(conservation.is_valid, true);
    assert.strictEqual(conservation.ledger_stats.difference, 0);
    assert.strictEqual(conservation.balance_stats.is_consistent, true);

    // Verify Account Statement running balance matches actual balance
    const aliceStatement = accountService.getAccountStatement(aliceAcc.id, { userId: alice.id, role: 'ACCOUNT_HOLDER' });
    assert.strictEqual(aliceStatement.is_balance_consistent, true, 'Alice running balance must match calculated balance');
    console.log(`✓ Alice Account Statement verified with ${aliceStatement.statement_entries.length} audited entries`);

    console.log('✓ PASS: Double-Entry Ledger and System-Wide Conservation 100% verified!');
    return true;
}

if (require.main === module) {
    testLedger().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

module.exports = { testLedger };

