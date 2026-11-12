// backend/tests/runTests.js
process.env.QUIET_LOGS = process.env.QUIET_LOGS || 'true';

const { testConcurrency } = require('./concurrency.test');
const { testIdempotency } = require('./idempotency.test');
const { testLedger } = require('./ledger.test');
const { testSecurity } = require('./security.test');
const { testAudit } = require('./audit.test');
const { testHttpE2E } = require('./http.e2e.test');
const { testImprovements } = require('./improvements.test');

async function runAllSuites() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║       LEDGERLINE / BALANCEVAULT AUTOMATED TEST SUITE        ║');
    console.log('║    Snovasys Fresher Hiring Challenge 2026 Verification       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    const startTime = Date.now();
    const suites = [
        { name: '1. Concurrency Protection (100 Parallel Requests)', fn: testConcurrency },
        { name: '2. Idempotency Key Validation & Replay Safety', fn: testIdempotency },
        { name: '3. Double-Entry Invariance & Conservation', fn: testLedger },
        { name: '4. Security, RBAC & Ownership Protection', fn: testSecurity },
        { name: '5. Append-Only Audit Trail & Immutability Triggers', fn: testAudit },
        { name: '6. HTTP E2E API, RBAC, Freeze & Rate Limiter', fn: testHttpE2E },
        { name: '7. Session Revocation, Lockout, Sweep, Filters, Metrics & Migrations', fn: testImprovements }
    ];

    let passed = 0;
    let failed = 0;

    for (const suite of suites) {
        try {
            await suite.fn();
            passed++;
        } catch (err) {
            failed++;
            console.error(`\n❌ FAILED: ${suite.name}`);
            console.error(err);
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('\n======================================================');
    console.log(` SUMMARY: ${passed} Passed, ${failed} Failed (${duration}s)`);
    console.log('======================================================');

    if (failed > 0) {
        console.error('❌ Some tests failed.');
        process.exit(1);
    } else {
        console.log('🏆 ALL AUTOMATED TEST SUITES PASSED! SYSTEM VERIFIED.');
        process.exit(0);
    }
}

runAllSuites();
