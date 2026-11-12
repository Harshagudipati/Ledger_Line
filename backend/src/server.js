// backend/src/server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { getDatabase, initDatabase } = require('./db/database');
const { ensureSeeded, resetAndSeedDatabase } = require('./db/seed');
const { AuthService } = require('./services/authService');
const { AccountService } = require('./services/accountService');
const { LedgerService } = require('./services/ledgerService');
const { AuditService } = require('./services/auditService');
const { AdminService } = require('./services/adminService');
const { authenticate } = require('./middleware/auth');
const { RateLimiter } = require('./middleware/rateLimiter');
const { TelemetryCollector } = require('./middleware/telemetry');
const { EventHub } = require('./middleware/eventHub');
const { buildOpenApiSpec } = require('./openapi');

function escapeCsvCell(val) {
    const s = val === null || val === undefined ? '' : String(val);
    return `"${s.replace(/"/g, '""')}"`;
}

function createServer(dbInstance = null, options = {}) {
    const db = dbInstance || getDatabase();

    let seedPromise = null;
    if (!options.skipAutoSeed) {
        seedPromise = ensureSeeded(db, { passwords: options.seedPasswords });
    }

    const eventHub = new EventHub();
    const auditService = new AuditService(db, (auditEvent) => {
        eventHub.publish('audit:event', auditEvent, [auditEvent.actorId]);
    });
    const authService = new AuthService(db);
    const accountService = new AccountService(db, auditService);
    const ledgerService = new LedgerService(db, auditService);
    const adminService = new AdminService(db, auditService, accountService);
    const telemetry = options.telemetry || new TelemetryCollector();

    const authLimiter = options.authLimiter || new RateLimiter({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        max: config.AUTH_RATE_LIMIT_MAX,
        prefix: 'auth'
    });
    const apiLimiter = options.apiLimiter || new RateLimiter({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        max: config.RATE_LIMIT_MAX_REQUESTS,
        prefix: 'api'
    });

    function getClientIp(req) {
        return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    }

    function sendJson(res, statusCode, data) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    async function authorizeRole(req, res, ...allowedRoles) {
        if (!req.user) {
            sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Authentication required' });
            return false;
        }
        if (!allowedRoles.includes(req.user.role)) {
            await auditService.record({
                actorId: req.user.userId,
                actorUsername: req.user.username,
                actorRole: req.user.role,
                action: 'RBAC_FORBIDDEN_ATTEMPT',
                entityType: 'AUTH',
                details: { path: req.url, method: req.method, requiredRoles: allowedRoles },
                ipAddress: getClientIp(req),
                status: 'UNAUTHORIZED'
            });
            sendJson(res, 403, {
                error: 'FORBIDDEN',
                message: `User role '${req.user.role}' lacks permission. Required: [${allowedRoles.join(', ')}]`
            });
            return false;
        }
        return true;
    }

    function parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 1e6) {
                    req.destroy();
                    reject(new Error('PAYLOAD_TOO_LARGE'));
                }
            });
            req.on('end', () => {
                if (!body.trim()) return resolve({});
                try {
                    resolve(JSON.parse(body));
                } catch {
                    reject(new Error('INVALID_JSON'));
                }
            });
            req.on('error', err => reject(err));
        });
    }

    const distDir = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
    const rawFrontendDir = path.resolve(__dirname, '..', '..', 'frontend');

    function getStaticRoot() {
        if (fs.existsSync(path.join(distDir, 'index.html'))) {
            return distDir;
        }
        return rawFrontendDir;
    }

    const server = http.createServer(async (req, res) => {
        if (seedPromise) {
            await seedPromise;
            seedPromise = null;
        }

        telemetry.beginRequest(req, res);

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id');

        const parsedUrl = new URL(req.url || '/', 'http://localhost');
        const pathname = parsedUrl.pathname;
        const query = Object.fromEntries(parsedUrl.searchParams.entries());
        const method = req.method;
        const ipAddress = getClientIp(req);

        if (pathname.startsWith('/api/') && pathname !== '/api/events/stream') {
            res.setHeader('Cache-Control', 'no-store');
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // Rate limiting (auth routes have dedicated tighter brute-force limits)
        if (pathname === '/api/auth/login' || pathname === '/api/auth/register' || pathname === '/api/auth/bootstrap') {
            if (!(await authLimiter.check(req, res, ipAddress))) return;
        } else if (pathname.startsWith('/api/')) {
            if (!(await apiLimiter.check(req, res, ipAddress))) return;
        }

        try {
            // ----------------------------------------------------------------
            // 1. Health, Readiness & Monitoring (FR-23)
            // ----------------------------------------------------------------
            if (pathname === '/api/health' && method === 'GET') {
                return sendJson(res, 200, {
                    status: 'UP',
                    timestamp: new Date().toISOString(),
                    service: 'LedgerLine / BalanceVault',
                    version: '1.1.0'
                });
            }

            if (pathname === '/api/ready' && method === 'GET') {
                await db.get('SELECT 1 as ok');
                return sendJson(res, 200, {
                    status: 'READY',
                    database: 'CONNECTED',
                    dialect: db.dialect,
                    rateLimiter: apiLimiter.getBackendMode(),
                    timestamp: new Date().toISOString()
                });
            }

            if (pathname === '/api/metrics' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN', 'AUDITOR'))) return;

                return sendJson(res, 200, telemetry.getSnapshot({
                    dbDialect: db.dialect,
                    rateLimitBackend: apiLimiter.getBackendMode()
                }));
            }

            if (pathname === '/api/openapi.json' && method === 'GET') {
                return sendJson(res, 200, buildOpenApiSpec());
            }

            if (pathname === '/api/events/stream' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                eventHub.subscribe(req, res, req.user);
                return;
            }

            // ----------------------------------------------------------------
            // 2. Authentication, Sessions & Bootstrap (FR-1, FR-4, FR-6)
            // ----------------------------------------------------------------
            if (pathname === '/api/auth/register' && method === 'POST') {
                const body = await parseBody(req);
                const result = await authService.register(body);
                await auditService.record({
                    actorId: result.id,
                    actorUsername: result.username,
                    actorRole: result.role,
                    action: 'USER_REGISTERED',
                    entityType: 'USER',
                    entityId: result.id,
                    details: { email: result.email, role: result.role },
                    ipAddress,
                    status: 'SUCCESS'
                });
                return sendJson(res, 201, result);
            }

            if (pathname === '/api/auth/login' && method === 'POST') {
                const body = await parseBody(req);
                try {
                    const result = await authService.login(body);
                    await auditService.record({
                        actorId: result.user.id,
                        actorUsername: result.user.username,
                        actorRole: result.user.role,
                        action: 'USER_LOGIN',
                        entityType: 'AUTH',
                        entityId: result.user.id,
                        ipAddress,
                        status: 'SUCCESS'
                    });
                    return sendJson(res, 200, result);
                } catch (loginErr) {
                    await auditService.record({
                        actorUsername: body?.username || 'unknown',
                        action: 'USER_LOGIN_FAILED',
                        entityType: 'AUTH',
                        details: { reason: loginErr.message },
                        ipAddress,
                        status: 'FAILURE'
                    });
                    throw loginErr;
                }
            }

            if (pathname === '/api/auth/logout' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                await authService.revokeToken({
                    jti: req.user.jti,
                    userId: req.user.userId,
                    exp: req.user.exp
                });
                await auditService.record({
                    actorId: req.user.userId,
                    actorUsername: req.user.username,
                    actorRole: req.user.role,
                    action: 'USER_LOGOUT',
                    entityType: 'AUTH',
                    entityId: req.user.userId,
                    ipAddress,
                    status: 'SUCCESS'
                });
                return sendJson(res, 200, { message: 'Signed out cleanly.' });
            }

            if (pathname === '/api/auth/change-password' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                const body = await parseBody(req);
                const result = await authService.changePassword({
                    userId: req.user.userId,
                    currentPassword: body.currentPassword,
                    newPassword: body.newPassword,
                    currentJti: req.user.jti,
                    currentExp: req.user.exp
                });
                await auditService.record({
                    actorId: req.user.userId,
                    actorUsername: req.user.username,
                    actorRole: req.user.role,
                    action: 'USER_PASSWORD_CHANGED',
                    entityType: 'USER',
                    entityId: req.user.userId,
                    ipAddress,
                    status: 'SUCCESS'
                });
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/auth/bootstrap-status' && method === 'GET') {
                const existingAdmin = await db.get(
                    "SELECT COUNT(*) as cnt FROM users WHERE role = 'ADMIN' AND id != ?",
                    config.SYSTEM_USER_ID
                );
                return sendJson(res, 200, { needsBootstrap: Number(existingAdmin.cnt) === 0 });
            }

            if (pathname === '/api/auth/bootstrap' && method === 'POST') {
                const body = await parseBody(req);
                const result = await authService.bootstrapAdmin(body);
                await auditService.record({
                    actorId: result.id,
                    actorUsername: result.username,
                    actorRole: 'ADMIN',
                    action: 'ADMIN_BOOTSTRAPPED',
                    entityType: 'USER',
                    entityId: result.id,
                    ipAddress,
                    status: 'SUCCESS'
                });
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/auth/me' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const user = await db.get(
                    'SELECT id, username, email, role, status, created_at FROM users WHERE id = ?',
                    req.user.userId
                );
                return sendJson(res, 200, { user });
            }

            // ----------------------------------------------------------------
            // 3. Accounts (FR-3, FR-9, FR-20)
            // ----------------------------------------------------------------
            if (pathname === '/api/accounts/recipients' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const recipients = await accountService.listTransferRecipients(query.excludeAccountId || null);
                return sendJson(res, 200, { recipients });
            }

            if (pathname === '/api/accounts' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const accounts = await accountService.getAccountsForUser(req.user);
                return sendJson(res, 200, { accounts });
            }

            if (pathname === '/api/accounts' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN'))) return;

                const body = await parseBody(req);
                const targetOwnerId = req.user.role === 'ADMIN' && body.ownerId ? body.ownerId : req.user.userId;

                const account = await accountService.createAccount({
                    ownerId: targetOwnerId,
                    accountType: body.accountType || 'CHECKING',
                    currency: body.currency || 'USD'
                });
                return sendJson(res, 201, { account });
            }

            const statementExportMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/statement\/export$/);
            if (statementExportMatch && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const accountId = statementExportMatch[1];
                const statement = await accountService.getAccountStatement(accountId, req.user, {
                    transactionType: query.transactionType || null,
                    fromDate: query.fromDate || null,
                    toDate: query.toDate || null,
                    search: query.search || null
                });
                const header = ['created_at', 'transaction_id', 'transaction_type', 'direction', 'amount_cents', 'running_balance_cents', 'description', 'idempotency_key'];
                const rows = statement.statement_entries.map(e => [
                    escapeCsvCell(e.created_at),
                    escapeCsvCell(e.transaction_id),
                    escapeCsvCell(e.transaction_type),
                    escapeCsvCell(e.direction),
                    escapeCsvCell(e.amount),
                    escapeCsvCell(e.running_balance),
                    escapeCsvCell(e.description || ''),
                    escapeCsvCell(e.idempotency_key)
                ].join(','));

                res.writeHead(200, {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': `attachment; filename="ledgerline-statement-${statement.account.account_number}.csv"`
                });
                res.end([header.join(','), ...rows].join('\n'));
                return;
            }

            const statementMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/statement$/);
            if (statementMatch && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const accountId = statementMatch[1];
                const statement = await accountService.getAccountStatement(accountId, req.user, {
                    transactionType: query.transactionType || null,
                    fromDate: query.fromDate || null,
                    toDate: query.toDate || null,
                    search: query.search || null
                });
                return sendJson(res, 200, statement);
            }

            const closeMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/close$/);
            if (closeMatch && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN'))) return;

                const body = await parseBody(req);
                const result = await accountService.closeAccountWithSweep({
                    accountId: closeMatch[1],
                    destinationAccountId: body.destinationAccountId || null,
                    destinationAccountNumber: body.destinationAccountNumber || null,
                    actor: req.user
                });
                eventHub.publish(
                    'account:status',
                    { accountId: result.account.id, status: 'CLOSED', sweptAmount: result.sweptAmount },
                    [result.account.owner_id, req.user.userId]
                );
                return sendJson(res, 200, result);
            }

            const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
            if (accountMatch && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const accountId = accountMatch[1];
                const account = await accountService.getAccountById(accountId);
                if (!account) {
                    return sendJson(res, 404, { error: 'ACCOUNT_NOT_FOUND', message: 'Account not found' });
                }
                if (req.user.role === 'ACCOUNT_HOLDER' && account.owner_id !== req.user.userId) {
                    throw new Error('UNAUTHORIZED_ACCOUNT_ACCESS');
                }
                return sendJson(res, 200, { account });
            }

            // ----------------------------------------------------------------
            // 4. Money Movement & Idempotency (FR-10 to FR-18)
            // ----------------------------------------------------------------
            if (pathname === '/api/transactions/deposit' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN'))) return;

                const body = await parseBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
                if (!idempotencyKey) {
                    return sendJson(res, 400, {
                        error: 'IDEMPOTENCY_KEY_REQUIRED',
                        message: 'Header Idempotency-Key is mandatory for deposit requests'
                    });
                }

                const result = await ledgerService.deposit({
                    accountId: body.accountId,
                    amount: Number(body.amount),
                    idempotencyKey,
                    description: body.description,
                    actor: req.user
                });

                if (!result.isCached) {
                    eventHub.publish('ledger:tx', { type: 'DEPOSIT', ...result }, [req.user.userId]);
                }

                return sendJson(res, result.isCached ? 200 : 201, result);
            }

            if (pathname === '/api/transactions/withdraw' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN'))) return;

                const body = await parseBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
                if (!idempotencyKey) {
                    return sendJson(res, 400, {
                        error: 'IDEMPOTENCY_KEY_REQUIRED',
                        message: 'Header Idempotency-Key is mandatory for withdrawal requests'
                    });
                }

                const result = await ledgerService.withdraw({
                    accountId: body.accountId,
                    amount: Number(body.amount),
                    idempotencyKey,
                    description: body.description,
                    actor: req.user
                });

                if (!result.isCached) {
                    eventHub.publish('ledger:tx', { type: 'WITHDRAWAL', ...result }, [req.user.userId]);
                }

                return sendJson(res, result.isCached ? 200 : 201, result);
            }

            if (pathname === '/api/transactions/transfer' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN'))) return;

                const body = await parseBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
                if (!idempotencyKey) {
                    return sendJson(res, 400, {
                        error: 'IDEMPOTENCY_KEY_REQUIRED',
                        message: 'Header Idempotency-Key is mandatory for transfer requests'
                    });
                }

                const result = await ledgerService.transfer({
                    sourceAccountId: body.sourceAccountId,
                    destinationAccountId: body.destinationAccountId,
                    destinationAccountNumber: body.destinationAccountNumber,
                    amount: Number(body.amount),
                    idempotencyKey,
                    description: body.description,
                    actor: req.user
                });

                if (!result.isCached) {
                    const destAcc = await accountService.getAccountById(result.destinationAccountId);
                    eventHub.publish(
                        'ledger:tx',
                        { type: 'TRANSFER', ...result },
                        [req.user.userId, destAcc?.owner_id]
                    );
                }

                return sendJson(res, result.isCached ? 200 : 201, result);
            }

            if (pathname === '/api/transactions/idempotency' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const keys = await ledgerService.getIdempotencyHistory(
                    req.user.userId,
                    query.limit ? parseInt(query.limit, 10) : 20
                );
                return sendJson(res, 200, { keys });
            }

            if (pathname === '/api/transactions' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const limit = query.limit ? parseInt(query.limit, 10) : 50;
                const offset = query.offset ? parseInt(query.offset, 10) : 0;
                const accountId = query.accountId || null;

                const transactions = await ledgerService.getTransactions({
                    limit,
                    offset,
                    accountId,
                    requestingUser: req.user,
                    type: query.type || null
                });
                return sendJson(res, 200, { transactions });
            }

            const txDetailMatch = pathname.match(/^\/api\/transactions\/([^/]+)$/);
            if (txDetailMatch && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const xray = await ledgerService.getTransactionXRay(txDetailMatch[1], req.user);
                return sendJson(res, 200, xray);
            }

            // ----------------------------------------------------------------
            // 5. Ledger & Conservation Verification (FR-14, FR-15)
            // ----------------------------------------------------------------
            if (pathname === '/api/ledger/conservation' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                const conservation = await ledgerService.verifyConservation();
                return sendJson(res, 200, conservation);
            }

            if (pathname === '/api/ledger/entries' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'AUDITOR', 'ADMIN'))) return;

                const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);
                let sql = `
                    SELECT le.id, le.transaction_id, le.account_id, le.direction, le.amount, le.created_at,
                           a.account_number, a.account_type, u.username as owner_username,
                           t.type as transaction_type, t.description
                    FROM ledger_entries le
                    JOIN accounts a ON le.account_id = a.id
                    JOIN users u ON a.owner_id = u.id
                    JOIN transactions t ON le.transaction_id = t.id
                    WHERE 1=1
                `;
                const params = [];
                if (query.transactionType) {
                    sql += ' AND t.type = ?';
                    params.push(query.transactionType);
                }
                if (query.direction) {
                    sql += ' AND le.direction = ?';
                    params.push(query.direction);
                }
                sql += ` ORDER BY ${db.orderByInsertion('le', 'DESC')} LIMIT ?`;
                params.push(limit);

                const entries = (await db.all(sql, ...params)).map(e => ({ ...e, amount: Number(e.amount) }));
                return sendJson(res, 200, { entries });
            }

            // ----------------------------------------------------------------
            // 6. Audit Logs, Hash Chain Verification & CSV Export (FR-19, FR-21)
            // ----------------------------------------------------------------
            if (pathname === '/api/audit/verify-chain' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'AUDITOR', 'ADMIN'))) return;

                const verification = await auditService.verifyHashChain();
                return sendJson(res, 200, verification);
            }

            if (pathname === '/api/audit/logs/export' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'AUDITOR', 'ADMIN'))) return;

                const auditData = await auditService.getLogs({
                    limit: 1000,
                    offset: 0,
                    entityType: query.entityType || null,
                    actorId: query.actorId || null,
                    status: query.status || null,
                    action: query.action || null,
                    search: query.search || null,
                    fromDate: query.fromDate || null,
                    toDate: query.toDate || null
                });

                const header = ['id', 'created_at', 'actor_username', 'actor_role', 'action', 'entity_type', 'entity_id', 'status', 'ip_address', 'details'];
                const rows = auditData.logs.map(l => [
                    escapeCsvCell(l.id),
                    escapeCsvCell(l.created_at),
                    escapeCsvCell(l.actor_username || 'system'),
                    escapeCsvCell(l.actor_role || ''),
                    escapeCsvCell(l.action),
                    escapeCsvCell(l.entity_type),
                    escapeCsvCell(l.entity_id || ''),
                    escapeCsvCell(l.status),
                    escapeCsvCell(l.ip_address || ''),
                    escapeCsvCell(typeof l.details === 'object' ? JSON.stringify(l.details) : (l.details || ''))
                ].join(','));

                res.writeHead(200, {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="ledgerline-audit-logs.csv"'
                });
                res.end([header.join(','), ...rows].join('\n'));
                return;
            }

            if (pathname === '/api/audit/logs' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'AUDITOR', 'ADMIN'))) return;

                const auditData = await auditService.getLogs({
                    limit: query.limit ? parseInt(query.limit, 10) : 50,
                    offset: query.offset ? parseInt(query.offset, 10) : 0,
                    entityType: query.entityType || null,
                    actorId: query.actorId || null,
                    status: query.status || null,
                    action: query.action || null,
                    search: query.search || null,
                    fromDate: query.fromDate || null,
                    toDate: query.toDate || null
                });
                return sendJson(res, 200, auditData);
            }

            // ----------------------------------------------------------------
            // 7. Admin User & Account Management (FR-7, FR-8, FR-9)
            // ----------------------------------------------------------------
            if (pathname === '/api/admin/users' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN'))) return;

                const users = await adminService.listUsers({
                    status: query.status || null,
                    role: query.role || null
                });
                return sendJson(res, 200, { users });
            }

            if (pathname === '/api/admin/users' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN'))) return;

                const body = await parseBody(req);
                const result = await adminService.createUser(body, req.user);
                return sendJson(res, 201, result);
            }

            const activateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/activate$/);
            if (activateMatch && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN'))) return;

                const result = await adminService.activateUser(activateMatch[1], req.user);
                return sendJson(res, 200, result);
            }

            const deactivateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/deactivate$/);
            if (deactivateMatch && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN'))) return;

                const result = await adminService.deactivateUser(deactivateMatch[1], req.user);
                return sendJson(res, 200, result);
            }

            const accountStatusMatch = pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/status$/);
            if (accountStatusMatch && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN'))) return;

                const body = await parseBody(req);
                const account = await accountService.updateAccountStatus(accountStatusMatch[1], body.status, req.user);
                eventHub.publish(
                    'account:status',
                    { accountId: account.id, accountNumber: account.account_number, status: account.status },
                    [account.owner_id]
                );
                return sendJson(res, 200, { account });
            }

            if (pathname === '/api/admin/stats' && method === 'GET') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN'))) return;

                const stats = await adminService.getSystemStats();
                return sendJson(res, 200, { stats });
            }

            if (pathname === '/api/admin/reset-seed' && method === 'POST') {
                if (!(await authenticate(req, res, db))) return;
                if (!(await authorizeRole(req, res, 'ADMIN'))) return;

                await resetAndSeedDatabase(db, req.user, { passwords: options.seedPasswords });
                return sendJson(res, 200, {
                    message: 'Demo balances and users reset to baseline; immutable audit trail preserved.'
                });
            }

            // ----------------------------------------------------------------
            // 8. Static Frontend Hosting (React dist build or fallback frontend)
            // ----------------------------------------------------------------
            if (!pathname.startsWith('/api/')) {
                const staticRoot = getStaticRoot();
                const cleanPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
                let filePath = path.resolve(staticRoot, cleanPath);

                if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) {
                    return sendJson(res, 403, { error: 'FORBIDDEN_PATH', message: 'Invalid static path' });
                }

                // SPA fallback for client routes (e.g. /login, /admin, /auditor)
                if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                    filePath = path.join(staticRoot, 'index.html');
                }

                if (fs.existsSync(filePath)) {
                    const ext = path.extname(filePath);
                    const mimeTypes = {
                        '.html': 'text/html; charset=utf-8',
                        '.js': 'application/javascript; charset=utf-8',
                        '.css': 'text/css; charset=utf-8',
                        '.json': 'application/json',
                        '.png': 'image/png',
                        '.svg': 'image/svg+xml'
                    };
                    const contentType = mimeTypes[ext] || 'application/octet-stream';
                    res.writeHead(200, { 'Content-Type': contentType });
                    fs.createReadStream(filePath).pipe(res);
                    return;
                }
            }

            return sendJson(res, 404, {
                error: 'NOT_FOUND',
                message: `Route '${method} ${pathname}' not found`
            });

        } catch (err) {
            if (err.message === 'UNAUTHORIZED_ACCOUNT_ACCESS') {
                await auditService.record({
                    actorId: req.user?.userId || null,
                    actorUsername: req.user?.username || null,
                    actorRole: req.user?.role || null,
                    action: 'UNAUTHORIZED_ACCOUNT_ACCESS',
                    entityType: 'ACCOUNT',
                    details: { path: pathname, method },
                    ipAddress,
                    status: 'UNAUTHORIZED'
                });
            }

            const statusMap = {
                'INVALID_JSON': 400,
                'PAYLOAD_TOO_LARGE': 413,
                'MISSING_FIELDS': 400,
                'PASSWORD_TOO_SHORT': 400,
                'MISSING_CREDENTIALS': 400,
                'INVALID_ROLE': 400,
                'INVALID_ACCOUNT_TYPE': 400,
                'INVALID_ACCOUNT_STATUS': 400,
                'INVALID_AMOUNT_MUST_BE_POSITIVE_INTEGER_CENTS': 400,
                'MISSING_REQUIRED_PARAMETERS': 400,
                'CANNOT_TRANSFER_TO_SAME_ACCOUNT': 400,
                'CANNOT_CLOSE_ACCOUNT_WITH_NONZERO_BALANCE': 400,
                'SWEEP_DESTINATION_REQUIRED': 400,
                'ACCOUNT_ALREADY_CLOSED': 400,
                'CANNOT_DEACTIVATE_OWN_ADMIN_ACCOUNT': 400,
                'INSUFFICIENT_FUNDS': 400,
                'ACCOUNT_NOT_ACTIVE': 400,
                'USER_NOT_ACTIVE': 400,
                'INVALID_CREDENTIALS': 401,
                'INVALID_CURRENT_PASSWORD': 401,
                'TOKEN_REVOKED': 401,
                'ACCOUNT_PENDING_APPROVAL': 403,
                'ACCOUNT_DEACTIVATED': 403,
                'UNAUTHORIZED_ACCOUNT_ACCESS': 403,
                'FORBIDDEN_SELF_REGISTRATION_ROLE': 403,
                'CANNOT_MODIFY_SYSTEM_CLEARING_ACCOUNT': 403,
                'CANNOT_DEACTIVATE_SYSTEM_ROOT': 403,
                'FORBIDDEN': 403,
                'ACCOUNT_NOT_FOUND': 404,
                'TRANSACTION_NOT_FOUND': 404,
                'SOURCE_ACCOUNT_NOT_FOUND': 404,
                'DESTINATION_ACCOUNT_NOT_FOUND': 404,
                'USER_NOT_FOUND': 404,
                'USER_ALREADY_EXISTS': 409,
                'ADMIN_ALREADY_BOOTSTRAPPED': 409,
                'CONCURRENT_TRANSACTION_IN_PROGRESS': 409,
                'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH': 422,
                'ACCOUNT_TEMPORARILY_LOCKED': 429
            };

            const statusCode = statusMap[err.message] || 500;
            if (statusCode === 500) {
                console.error('Server error:', err);
            }
            return sendJson(res, statusCode, {
                error: err.message,
                message: err.message
            });
        }
    });

    server.on('close', () => {
        eventHub.closeAll();
    });

    return server;
}

async function startServer() {
    const db = await initDatabase();
    await ensureSeeded(db);
    const server = createServer(db, { skipAutoSeed: true });
    server.listen(config.PORT, () => {
        console.log('====================================================');
        console.log(' LedgerLine / BalanceVault Core API Running');
        console.log(` DB Dialect:   ${db.dialect}`);
        console.log(` Rate Limiter: ${config.REDIS_URL ? 'redis (+ memory fallback)' : 'in-memory'}`);
        console.log(` Port:         http://localhost:${config.PORT}`);
        console.log(` Health:       http://localhost:${config.PORT}/api/health`);
        console.log(` Ready:        http://localhost:${config.PORT}/api/ready`);
        console.log('====================================================');
    });
    return server;
}

if (require.main === module) {
    startServer().catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}

module.exports = { createServer, startServer };
