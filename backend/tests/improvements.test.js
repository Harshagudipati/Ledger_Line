// backend/tests/improvements.test.js
const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');
const { getDatabase } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrate');
const { createServer } = require('../src/server');
const { RateLimiter } = require('../src/middleware/rateLimiter');
const { TEST_PASSWORDS } = require('./testFixtures');

function dispatchHttp(server, { method = 'GET', path = '/', headers = {}, body = null, ip = '10.0.0.2' }) {
    return new Promise((resolve, reject) => {
        const bodyStr = body === null || body === undefined
            ? ''
            : typeof body === 'string' ? body : JSON.stringify(body);

        const req = new Readable({
            read() {
                if (bodyStr.length > 0) this.push(bodyStr);
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
        res.setHeader = (name, val) => { responseHeaders[name.toLowerCase()] = String(val); };
        res.getHeader = (name) => responseHeaders[name.toLowerCase()];
        res.writeHead = (code, hdrs = {}) => {
            res.statusCode = code;
            for (const [k, v] of Object.entries(hdrs)) res.setHeader(k, v);
            return res;
        };
        res.on('finish', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = rawBody ? JSON.parse(rawBody) : null; } catch { json = null; }
            resolve({ statusCode: res.statusCode, headers: responseHeaders, body: rawBody, json });
        });
        res.on('error', reject);
        server.emit('request', req, res);
    });
}

async function testImprovements() {
    console.log('\n======================================================');
    console.log(' TEST SUITE 7: Session Revocation, Lockout, Sweep, Filters, Metrics & Migrations');
    console.log('======================================================');

    const db = getDatabase(':memory:', true);
    await runMigrations(db);
    await runMigrations(db); // Verify migration runner is safely idempotent
    const migRow = await db.get("SELECT version FROM schema_migrations WHERE version = '001_baseline_sqlite'");
    assert.ok(migRow, 'Migration version 001_baseline_sqlite must be recorded');
    console.log('✓ 1. Migration runner applied cleanly & idempotently');

    const server = createServer(db, {
        seedPasswords: TEST_PASSWORDS,
        authLimiter: new RateLimiter({ windowMs: 60000, max: 100 }),
        apiLimiter: new RateLimiter({ windowMs: 60000, max: 500 })
    });

    // Ensure X-Request-Id header is returned
    const health = await dispatchHttp(server, { method: 'GET', path: '/api/health' });
    assert.strictEqual(health.statusCode, 200);
    assert.ok(health.headers['x-request-id'], 'Telemetry must attach X-Request-Id header');

    // Login Alice & Bob
    const aliceLogin1 = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'alice', password: TEST_PASSWORDS.alice }
    });
    assert.strictEqual(aliceLogin1.statusCode, 200);
    const aliceToken1 = aliceLogin1.json.token;

    // Logout -> token immediately revoked
    const logoutRes = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/logout',
        headers: { Authorization: `Bearer ${aliceToken1}` }
    });
    assert.strictEqual(logoutRes.statusCode, 200);

    const replayRevoked = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/accounts',
        headers: { Authorization: `Bearer ${aliceToken1}` }
    });
    assert.strictEqual(replayRevoked.statusCode, 401);
    assert.strictEqual(replayRevoked.json.error, 'TOKEN_REVOKED');
    console.log('✓ 2. Server-side POST /api/auth/logout revokes JWT immediately (TOKEN_REVOKED)');

    // Re-login Alice -> Change Password -> Old token revoked & fresh token works
    const aliceLogin2 = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'alice', password: TEST_PASSWORDS.alice }
    });
    const aliceToken2 = aliceLogin2.json.token;

    const badChg = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/change-password',
        headers: { Authorization: `Bearer ${aliceToken2}` },
        body: { currentPassword: 'WrongCurrentPassword!', newPassword: 'NewAlicePassword9!' }
    });
    assert.strictEqual(badChg.statusCode, 401);

    const goodChg = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/change-password',
        headers: { Authorization: `Bearer ${aliceToken2}` },
        body: { currentPassword: TEST_PASSWORDS.alice, newPassword: 'NewAlicePassword9!' }
    });
    assert.strictEqual(goodChg.statusCode, 200);
    const aliceFreshToken = goodChg.json.token;
    assert.ok(aliceFreshToken);

    const oldTokenAfterPwChange = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/accounts',
        headers: { Authorization: `Bearer ${aliceToken2}` }
    });
    assert.strictEqual(oldTokenAfterPwChange.statusCode, 401);
    assert.strictEqual(oldTokenAfterPwChange.json.error, 'TOKEN_REVOKED');

    const newPwLogin = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'alice', password: 'NewAlicePassword9!' }
    });
    assert.strictEqual(newPwLogin.statusCode, 200);
    console.log('✓ 3. Password change rotates token, revokes prior JWT & authenticates with new password');

    // Failed login lockout (5 attempts -> ACCOUNT_TEMPORARILY_LOCKED) + Admin unlock
    for (let i = 0; i < 4; i++) {
        const failRes = await dispatchHttp(server, {
            method: 'POST',
            path: '/api/auth/login',
            body: { username: 'bob', password: 'WrongPassword!' }
        });
        assert.strictEqual(failRes.statusCode, 401);
    }
    const lockRes = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'bob', password: 'WrongPassword!' }
    });
    assert.strictEqual(lockRes.statusCode, 429);
    assert.strictEqual(lockRes.json.error, 'ACCOUNT_TEMPORARILY_LOCKED');

    const adminLogin = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'admin', password: TEST_PASSWORDS.admin }
    });
    const adminToken = adminLogin.json.token;

    const bobAccLookup = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/admin/users',
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    const bobUser = bobAccLookup.json.users.find(u => u.username === 'bob');
    assert.ok(bobUser.locked_until, 'Locked user must surface locked_until timestamp to Admin');

    await dispatchHttp(server, {
        method: 'POST',
        path: `/api/admin/users/${bobUser.id}/activate`,
        headers: { Authorization: `Bearer ${adminToken}` }
    });

    const bobLoginAfterUnlock = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username: 'bob', password: TEST_PASSWORDS.bob }
    });
    assert.strictEqual(bobLoginAfterUnlock.statusCode, 200);
    console.log('✓ 4. Brute-force lockout (5 attempts -> 429) & Admin unlock verified');

    // Alice opens Savings account, deposits, tests filtered statement + idempotency history + Close with Balance Sweep
    const aliceAccs = (await dispatchHttp(server, {
        method: 'GET',
        path: '/api/accounts',
        headers: { Authorization: `Bearer ${aliceFreshToken}` }
    })).json.accounts;
    const primaryAcc = aliceAccs[0];

    const savingsRes = await dispatchHttp(server, {
        method: 'POST',
        path: '/api/accounts',
        headers: { Authorization: `Bearer ${aliceFreshToken}` },
        body: { accountType: 'SAVINGS' }
    });
    assert.strictEqual(savingsRes.statusCode, 201);
    const savingsAcc = savingsRes.json.account;

    await dispatchHttp(server, {
        method: 'POST',
        path: '/api/transactions/deposit',
        headers: { Authorization: `Bearer ${aliceFreshToken}`, 'Idempotency-Key': 'sweep-dep-1' },
        body: { accountId: savingsAcc.id, amount: 25000, description: 'Payroll Savings' }
    });

    const filteredStmt = await dispatchHttp(server, {
        method: 'GET',
        path: `/api/accounts/${savingsAcc.id}/statement?transactionType=DEPOSIT&search=Payroll`,
        headers: { Authorization: `Bearer ${aliceFreshToken}` }
    });
    assert.strictEqual(filteredStmt.statusCode, 200);
    assert.strictEqual(filteredStmt.json.statement_entries.length, 1);
    assert.strictEqual(filteredStmt.json.statement_entries[0].running_balance, 25000);

    const idemHist = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/transactions/idempotency',
        headers: { Authorization: `Bearer ${aliceFreshToken}` }
    });
    assert.strictEqual(idemHist.statusCode, 200);
    assert.ok(idemHist.json.keys.some(k => k.key === 'sweep-dep-1' && k.status === 'COMPLETED'));

    const closeRes = await dispatchHttp(server, {
        method: 'POST',
        path: `/api/accounts/${savingsAcc.id}/close`,
        headers: { Authorization: `Bearer ${aliceFreshToken}` },
        body: { destinationAccountId: primaryAcc.id }
    });
    assert.strictEqual(closeRes.statusCode, 200);
    assert.strictEqual(closeRes.json.account.status, 'CLOSED');
    assert.strictEqual(closeRes.json.account.balance, 0);
    assert.strictEqual(closeRes.json.sweptAmount, 25000);

    const conservationAfterSweep = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/ledger/conservation',
        headers: { Authorization: `Bearer ${aliceFreshToken}` }
    });
    assert.strictEqual(conservationAfterSweep.json.is_valid, true);
    console.log('✓ 5. Filtered statement, idempotency history & atomic close-with-sweep verified');

    // Telemetry Metrics & Audit Filter/CSV Export (RBAC protected)
    const holderMetricsForbidden = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/metrics',
        headers: { Authorization: `Bearer ${aliceFreshToken}` }
    });
    assert.strictEqual(holderMetricsForbidden.statusCode, 403);

    const adminMetrics = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/metrics',
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(adminMetrics.statusCode, 200);
    assert.ok(adminMetrics.json.totalRequests >= 5);
    assert.strictEqual(adminMetrics.json.backends.database, 'sqlite');

    const auditCsv = await dispatchHttp(server, {
        method: 'GET',
        path: '/api/audit/logs/export?search=USER_LOGOUT',
        headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(auditCsv.statusCode, 200);
    assert.ok(auditCsv.headers['content-type'].includes('text/csv'));
    assert.ok(auditCsv.body.includes('USER_LOGOUT'));
    console.log('✓ 6. /api/metrics telemetry & /api/audit/logs/export CSV verified');

    await db.close();
    console.log('✓ PASS: All Phase 1 hardening & new API capabilities verified!');
}

module.exports = { testImprovements };
