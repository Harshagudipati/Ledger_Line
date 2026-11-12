// backend/tests/http.e2e.test.js
const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');
const { getDatabase } = require('../src/db/database');
const { createServer } = require('../src/server');
const { RateLimiter } = require('../src/middleware/rateLimiter');
const { TEST_PASSWORDS } = require('./testFixtures');

/**
 * In-process HTTP dispatcher using Node streams (`server.emit('request', req, res)`)
 * so full routing, headers, auth, rate limiting, and JSON handling are tested
 * without requiring a TCP port bind.
 */
function dispatchHttp(server, { method = 'GET', path = '/', headers = {}, body = null, ip = '10.0.0.1' }) {
    return new Promise((resolve, reject) => {
        const bodyStr = body === null || body === undefined
            ? ''
            : typeof body === 'string' ? body : JSON.stringify(body);

        const req = new Readable({
            read() {
                if (bodyStr.length > 0) {
                    this.push(bodyStr);
                }
                this.push(null);
            }
        });

        const normalizedHeaders = {};
        for (const [k, v] of Object.entries(headers)) {
            normalizedHeaders[k.toLowerCase()] = v;
        }
        if (bodyStr && !normalizedHeaders['content-type']) {
            normalizedHeaders['content-type'] = 'application/json';
        }

        req.method = method.toUpperCase();
        req.url = path;
        req.headers = normalizedHeaders;
        req.socket = { remoteAddress: ip };

        const responseHeaders = {};
        const chunks = [];

        const res = new Writable({
            write(chunk, encoding, callback) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
                callback();
            }
        });

        res.statusCode = 200;
        res.setHeader = (name, val) => {
            responseHeaders[name.toLowerCase()] = String(val);
        };
        res.getHeader = (name) => responseHeaders[name.toLowerCase()];
        res.writeHead = (code, hdrs = {}) => {
            res.statusCode = code;
            for (const [k, v] of Object.entries(hdrs)) {
                res.setHeader(k, v);
            }
            return res;
        };

        res.on('finish', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
                json = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                json = null;
            }
            resolve({
                statusCode: res.statusCode,
                headers: responseHeaders,
                body: rawBody,
                json
            });
        });

        res.on('error', reject);
        server.emit('request', req, res);
    });
}

async function testHttpE2E() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 6: End-to-End HTTP API, RBAC, Freeze & Rate Limit');
    console.log('======================================================');

    // Fresh in-memory DB without manual seeding tests auto-seed on createServer()
    const db = getDatabase(':memory:', true);
    const server = createServer(db, { seedPasswords: TEST_PASSWORDS });

    // 1. Health, Readiness, Bootstrap Status & Auto-Seeded Conservation
    const health = await dispatchHttp(server, { method: 'GET', path: '/api/health' });
    assert.strictEqual(health.statusCode, 200);
    assert.strictEqual(health.json.status, 'UP');

    const ready = await dispatchHttp(server, { method: 'GET', path: '/api/ready' });
    assert.strictEqual(ready.statusCode, 200);
    assert.strictEqual(ready.json.status, 'READY');
    assert.strictEqual(ready.json.database, 'CONNECTED');

    const bootStatusSeeded = await dispatchHttp(server, { method: 'GET', path: '/api/auth/bootstrap-status' });
    assert.strictEqual(bootStatusSeeded.statusCode, 200);
    assert.strictEqual(bootStatusSeeded.json.needsBootstrap, false);

    // Also verify fresh blank database reports needsBootstrap: true and allows first-admin bootstrap
    const blankDb = getDatabase(':memory:', true);
    const blankServer = createServer(blankDb, { skipAutoSeed: true });
    const bootStatusBlank = await dispatchHttp(blankServer, { method: 'GET', path: '/api/auth/bootstrap-status' });
    assert.strictEqual(bootStatusBlank.statusCode, 200);
    assert.strictEqual(bootStatusBlank.json.needsBootstrap, true);
    const bootInit = await dispatchHttp(blankServer, {
        method: 'POST',
        path: '/api/auth/bootstrap',
        body: { username: 'root_admin', email: 'root@example.com', password: 'RootPassword123!' }
    });
    assert.strictEqual(bootInit.statusCode, 200);
    assert.strictEqual(bootInit.json.role, 'ADMIN');
    const bootStatusAfter = await dispatchHttp(blankServer, { method: 'GET', path: '/api/auth/bootstrap-status' });
    assert.strictEqual(bootStatusAfter.json.needsBootstrap, false);
    blankDb.close();

    const unauthConservation = await dispatchHttp(server, { method: 'GET', path: '/api/ledger/conservation' });
    assert.strictEqual(unauthConservation.statusCode, 401);

    const auditorInitLogin = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'auditor', password: 'AuditorPassword123!' }
    });
    assert.strictEqual(auditorInitLogin.statusCode, 200);

    const initialConservation = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/ledger/conservation',
        headers: { Authorization: `Bearer ${auditorInitLogin.json.token}` }
    });
    assert.strictEqual(initialConservation.statusCode, 200);
    assert.strictEqual(initialConservation.json.is_valid, true);
    assert.strictEqual(initialConservation.json.balance_stats.total_customer_balances, 150000);
    console.log('✓ 1. /api/health, /api/ready & auto-seed on empty DB verified');

    // 2. Self-Registration Role Restriction & Pending Onboarding Workflow
    const badReg = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/register',
        body: { username: 'rogue', email: 'rogue@example.com', password: 'StrongPassword123!', role: 'ADMIN' }
    });
    assert.strictEqual(badReg.statusCode, 403);
    assert.strictEqual(badReg.json.error, 'FORBIDDEN_SELF_REGISTRATION_ROLE');

    const reg = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/register',
        body: { username: 'dana', email: 'dana@example.com', password: 'DanaPassword123!' }
    });
    assert.strictEqual(reg.statusCode, 201);
    assert.strictEqual(reg.json.role, 'ACCOUNT_HOLDER');
    assert.strictEqual(reg.json.status, 'PENDING_APPROVAL');

    const pendingLogin = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'dana', password: 'DanaPassword123!' }
    });
    assert.strictEqual(pendingLogin.statusCode, 403);
    assert.strictEqual(pendingLogin.json.error, 'ACCOUNT_PENDING_APPROVAL');

    const adminLogin = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'admin', password: 'AdminPassword123!' }
    });
    assert.strictEqual(adminLogin.statusCode, 200);
    const adminToken = adminLogin.json.token;

    const approveDana = await dispatchHttp(server, {
        method: 'POST',
        path: `/api/admin/users/${reg.json.id}/activate`,
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(approveDana.statusCode, 200);

    const danaLogin = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'dana', password: 'DanaPassword123!' }
    });
    assert.strictEqual(danaLogin.statusCode, 200);

    const danaOpenAcc = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/accounts',
        headers: { Authorization: `Bearer ${danaLogin.json.token}` },
        body: { accountType: 'SAVINGS' }
    });
    assert.strictEqual(danaOpenAcc.statusCode, 201);
    assert.strictEqual(danaOpenAcc.json.account.account_type, 'SAVINGS');
    console.log('✓ 2. Public registration restricted to ACCOUNT_HOLDER + admin onboarding verified');

    // 3. Admin Create User
    const adminCreateAuditor = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/admin/users',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: {
            username: 'compliance_lead',
            email: 'lead@ledgerline.local',
            password: 'LeadPassword123!',
            role: 'AUDITOR'
        }
    });
    assert.strictEqual(adminCreateAuditor.statusCode, 201);
    assert.strictEqual(adminCreateAuditor.json.role, 'AUDITOR');
    assert.strictEqual(adminCreateAuditor.json.status, 'ACTIVE');

    const adminStatsRes = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/admin/stats',
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(adminStatsRes.statusCode, 200);
    assert.ok(adminStatsRes.json.stats.users.total_users >= 6);

    // 4. Money Movement, Cross-User Transfer by Account Number & Idempotency Header Replay
    const aliceLogin = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'alice', password: 'AlicePassword123!' }
    });
    const aliceToken = aliceLogin.json.token;

    const aliceAccs = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/accounts',
        headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const aliceAcc = aliceAccs.json.accounts[0];

    const recipientsRes = await dispatchHttp(server, {
        method: 'GET',
        path: `/api/accounts/recipients?excludeAccountId=${aliceAcc.id}`,
        headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.strictEqual(recipientsRes.statusCode, 200);
    const bobRecipient = recipientsRes.json.recipients.find(r => r.owner_username === 'bob');
    assert.ok(bobRecipient, 'Bob must appear in transfer recipients directory');
    assert.strictEqual(bobRecipient.balance, undefined, 'Recipients directory must not leak balances');
    assert.strictEqual(bobRecipient.email, undefined, 'Recipients directory must not leak emails');

    // Deposit + Replay
    const depRes1 = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/transactions/deposit',
        headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Idempotency-Key': 'http-e2e-dep-1'
        },
        body: { accountId: aliceAcc.id, amount: 20000, description: 'E2E Deposit' }
    });
    assert.strictEqual(depRes1.statusCode, 201);
    assert.strictEqual(depRes1.json.newBalance, 120000);

    const depReplay = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/transactions/deposit',
        headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Idempotency-Key': 'http-e2e-dep-1'
        },
        body: { accountId: aliceAcc.id, amount: 20000, description: 'E2E Deposit' }
    });
    assert.strictEqual(depReplay.statusCode, 200);
    assert.strictEqual(depReplay.json.isCached, true);
    assert.strictEqual(depReplay.json.newBalance, 120000);

    // Transfer to Bob using destinationAccountNumber
    const xferRes = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/transactions/transfer',
        headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Idempotency-Key': 'http-e2e-xfer-1'
        },
        body: {
            sourceAccountId: aliceAcc.id,
            destinationAccountNumber: bobRecipient.account_number,
            amount: 15000,
            description: 'Transfer by account number'
        }
    });
    assert.strictEqual(xferRes.statusCode, 201);
    assert.strictEqual(xferRes.json.sourceNewBalance, 105000);
    assert.strictEqual(xferRes.json.destinationNewBalance, 65000);

    // Withdraw
    const wdlRes = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/transactions/withdraw',
        headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Idempotency-Key': 'http-e2e-wdl-1'
        },
        body: { accountId: aliceAcc.id, amount: 5000, description: 'E2E ATM' }
    });
    assert.strictEqual(wdlRes.statusCode, 201);
    assert.strictEqual(wdlRes.json.newBalance, 100000);
    console.log('✓ 3. Recipients privacy, Deposit replay, Account-number Transfer & Withdraw verified');

    // 5. FR-3 Ownership on GET /api/transactions & POST /api/transactions/deposit
    const unauthTxRead = await dispatchHttp(server, {
        method: 'GET',
        path: `/api/transactions?accountId=${bobRecipient.id}`,
        headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.strictEqual(unauthTxRead.statusCode, 403);
    assert.strictEqual(unauthTxRead.json.error, 'UNAUTHORIZED_ACCOUNT_ACCESS');

    const unauthDep = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/transactions/deposit',
        headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Idempotency-Key': 'http-e2e-unauth-dep'
        },
        body: { accountId: bobRecipient.id, amount: 1000 }
    });
    assert.strictEqual(unauthDep.statusCode, 403);
    assert.strictEqual(unauthDep.json.error, 'UNAUTHORIZED_ACCOUNT_ACCESS');

    // 6. Account Freeze / Unfreeze (FR-9)
    const freezeRes = await dispatchHttp(server, {
        method: 'POST',
        path: `/api/admin/accounts/${aliceAcc.id}/status`,
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { status: 'FROZEN' }
    });
    assert.strictEqual(freezeRes.statusCode, 200);
    assert.strictEqual(freezeRes.json.account.status, 'FROZEN');

    const frozenWithdraw = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/transactions/withdraw',
        headers: {
            Authorization: `Bearer ${aliceToken}`,
            'Idempotency-Key': 'http-e2e-frozen-wdl'
        },
        body: { accountId: aliceAcc.id, amount: 1000 }
    });
    assert.strictEqual(frozenWithdraw.statusCode, 400);
    assert.strictEqual(frozenWithdraw.json.error, 'ACCOUNT_NOT_ACTIVE');

    const unfreezeRes = await dispatchHttp(server, {
        method: 'POST',
        path: `/api/admin/accounts/${aliceAcc.id}/status`,
        headers: { Authorization: `Bearer ${adminToken}` },
        body: { status: 'ACTIVE' }
    });
    assert.strictEqual(unfreezeRes.statusCode, 200);
    assert.strictEqual(unfreezeRes.json.account.status, 'ACTIVE');
    console.log('✓ 4. FR-3 ownership enforcement + FR-9 FROZEN account blocking verified');

    // 7. RBAC 401/403 & Failed Login Audit Logging + Reset-Seed Preserving Audit Logs
    const unauthStats = await dispatchHttp(server, { method: 'GET', path: '/api/admin/stats' });
    assert.strictEqual(unauthStats.statusCode, 401);

    const forbiddenStats = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/admin/stats',
        headers: { Authorization: `Bearer ${aliceToken}` }
    });
    assert.strictEqual(forbiddenStats.statusCode, 403);

    const badPassword = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'alice', password: 'WrongPassword!' }
    });
    assert.strictEqual(badPassword.statusCode, 401);

    const auditCountBeforeReset = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get().cnt;

    const resetRes = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/admin/reset-seed',
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(resetRes.statusCode, 200);

    const auditCountAfterReset = db.prepare('SELECT COUNT(*) as cnt FROM audit_logs').get().cnt;
    assert.ok(auditCountAfterReset > auditCountBeforeReset, 'Reset-seed must preserve append-only audit_logs and log DEMO_DATABASE_RESET');

    const logs = db.prepare('SELECT action, status FROM audit_logs').all();
    assert.ok(logs.some(l => l.action === 'RBAC_FORBIDDEN_ATTEMPT' && l.status === 'UNAUTHORIZED'));
    assert.ok(logs.some(l => l.action === 'USER_LOGIN_FAILED' && l.status === 'FAILURE'));
    assert.ok(logs.some(l => l.action === 'DEMO_DATABASE_RESET' && l.status === 'SUCCESS'));
    console.log('✓ 5. RBAC/Failed-login audit records & audit-preserving reset-seed verified');

    // 8. Rate Limiter Enforcement (429 + Retry-After)
    const strictDb = getDatabase(':memory:', true);
    const strictServer = createServer(strictDb, {
        seedPasswords: TEST_PASSWORDS,
        authLimiter: new RateLimiter({ windowMs: 60000, max: 2 })
    });

    const rl1 = await dispatchHttp(strictServer, {
        method: 'POST',
        path: '/api/auth/login',
        ip: '203.0.113.9',
        body: { username: 'alice', password: 'AlicePassword123!' }
    });
    assert.strictEqual(rl1.statusCode, 200);

    const rl2 = await dispatchHttp(strictServer, {
        method: 'POST',
        path: '/api/auth/login',
        ip: '203.0.113.9',
        body: { username: 'alice', password: 'AlicePassword123!' }
    });
    assert.strictEqual(rl2.statusCode, 200);

    const rl3 = await dispatchHttp(strictServer, {
        method: 'POST',
        path: '/api/auth/login',
        ip: '203.0.113.9',
        body: { username: 'alice', password: 'AlicePassword123!' }
    });
    assert.strictEqual(rl3.statusCode, 429);
    assert.strictEqual(rl3.json.error, 'RATE_LIMIT_EXCEEDED');
    assert.ok(Number(rl3.headers['retry-after']) >= 1);
    assert.strictEqual(rl3.headers['x-ratelimit-remaining'], '0');
    console.log('✓ 6. HTTP 429 auth rate limit + Retry-After headers verified');

    db.close();
    strictDb.close();
    console.log('✓ PASS: All HTTP End-to-End API, Security, Freeze & Rate Limit checks passed!');
}

module.exports = { testHttpE2E };
