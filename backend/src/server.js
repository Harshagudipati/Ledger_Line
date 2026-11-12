// backend/src/server.js
const http = require('node:http');
const url = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { getDatabase } = require('./db/database');
const { ensureSeeded, resetAndSeedDatabase } = require('./db/seed');
const { AuthService } = require('./services/authService');
const { AccountService } = require('./services/accountService');
const { LedgerService } = require('./services/ledgerService');
const { AuditService } = require('./services/auditService');
const { AdminService } = require('./services/adminService');
const { authenticate } = require('./middleware/auth');
const { RateLimiter } = require('./middleware/rateLimiter');

function createServer(dbInstance = null, options = {}) {
    const db = dbInstance || getDatabase();

    // Auto-seed empty database on first boot so fresh clones work out of the box
    if (!options.skipAutoSeed) {
        ensureSeeded(db);
    }

    const auditService = new AuditService(db);
    const authService = new AuthService(db);
    const accountService = new AccountService(db, auditService);
    const ledgerService = new LedgerService(db, auditService);
    const adminService = new AdminService(db, auditService, accountService);

    const authLimiter = options.authLimiter || new RateLimiter({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        max: config.AUTH_RATE_LIMIT_MAX
    });
    const apiLimiter = options.apiLimiter || new RateLimiter({
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        max: config.RATE_LIMIT_MAX_REQUESTS
    });

    function getClientIp(req) {
        return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    }

    // Helper to send JSON response
    function sendJson(res, statusCode, data) {
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
            'Cache-Control': 'no-store'
        });
        res.end(JSON.stringify(data));
    }

    // Helper to check RBAC role and record UNAUTHORIZED access attempts in the audit log
    function authorizeRole(req, res, ...allowedRoles) {
        if (!req.user) {
            sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Authentication required' });
            return false;
        }
        if (!allowedRoles.includes(req.user.role)) {
            auditService.record({
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

    // Helper to parse JSON body
    function parseBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 1e6) { // 1MB limit
                    req.destroy();
                    reject(new Error('PAYLOAD_TOO_LARGE'));
                }
            });
            req.on('end', () => {
                if (!body.trim()) return resolve({});
                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error('INVALID_JSON'));
                }
            });
            req.on('error', reject);
        });
    }

    const server = http.createServer(async (req, res) => {
        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key'
            });
            res.end();
            return;
        }

        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const query = parsedUrl.query;
        const method = req.method;
        const ipAddress = getClientIp(req);

        // Apply Rate Limiting on API routes (strict on sensitive auth routes, generous on general API)
        if (pathname.startsWith('/api/')) {
            const isSensitiveAuthRoute =
                pathname === '/api/auth/login' ||
                pathname === '/api/auth/register' ||
                pathname === '/api/auth/bootstrap';

            if (isSensitiveAuthRoute) {
                if (!authLimiter.check(req, res)) {
                    auditService.record({
                        action: 'RATE_LIMIT_TRIGGERED',
                        entityType: 'AUTH',
                        details: { path: pathname },
                        ipAddress,
                        status: 'FAILURE'
                    });
                    return;
                }
            } else if (!apiLimiter.check(req, res)) {
                return;
            }
        }

        try {
            // ----------------------------------------------------------------
            // 1. Health & Operations (FR-23)
            // ----------------------------------------------------------------
            if (pathname === '/api/health' && method === 'GET') {
                return sendJson(res, 200, {
                    status: 'UP',
                    timestamp: new Date().toISOString(),
                    service: 'LedgerLine / BalanceVault',
                    version: '1.0.0'
                });
            }

            if (pathname === '/api/ready' && method === 'GET') {
                db.prepare('SELECT 1').get();
                return sendJson(res, 200, {
                    status: 'READY',
                    database: 'CONNECTED',
                    timestamp: new Date().toISOString()
                });
            }

            // ----------------------------------------------------------------
            // 2. Authentication & Bootstrap (FR-1, FR-4, FR-6)
            // ----------------------------------------------------------------
            if (pathname === '/api/auth/register' && method === 'POST') {
                const body = await parseBody(req);
                const result = authService.register(body);
                auditService.record({
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
                    const result = authService.login(body);
                    auditService.record({
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
                    auditService.record({
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

            if (pathname === '/api/auth/bootstrap' && method === 'POST') {
                const body = await parseBody(req);
                const result = authService.bootstrapAdmin(body);
                auditService.record({
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
                if (!authenticate(req, res)) return;
                const user = db.prepare('SELECT id, username, email, role, status, created_at FROM users WHERE id = ?').get(req.user.userId);
                return sendJson(res, 200, { user });
            }

            // ----------------------------------------------------------------
            // 3. Accounts (FR-3, FR-9, FR-20)
            // ----------------------------------------------------------------
            if (pathname === '/api/accounts/recipients' && method === 'GET') {
                if (!authenticate(req, res)) return;
                const recipients = accountService.listTransferRecipients(query.excludeAccountId || null);
                return sendJson(res, 200, { recipients });
            }

            if (pathname === '/api/accounts' && method === 'GET') {
                if (!authenticate(req, res)) return;
                const accounts = accountService.getAccountsForUser(req.user);
                return sendJson(res, 200, { accounts });
            }

            if (pathname === '/api/accounts' && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN')) return;
                const body = await parseBody(req);
                
                const ownerId = req.user.role === 'ADMIN' ? (body.ownerId || req.user.userId) : req.user.userId;
                const account = accountService.createAccount({
                    ownerId,
                    accountType: body.accountType || 'CHECKING',
                    currency: body.currency || 'USD'
                });

                auditService.record({
                    actorId: req.user.userId,
                    actorUsername: req.user.username,
                    actorRole: req.user.role,
                    action: 'ACCOUNT_CREATED',
                    entityType: 'ACCOUNT',
                    entityId: account.id,
                    details: { accountNumber: account.account_number, type: account.account_type },
                    ipAddress,
                    status: 'SUCCESS'
                });

                return sendJson(res, 201, { account });
            }

            // Match /api/accounts/:id/statement
            const statementMatch = pathname.match(/^\/api\/accounts\/([^/]+)\/statement$/);
            if (statementMatch && method === 'GET') {
                if (!authenticate(req, res)) return;
                const accountId = statementMatch[1];
                const statement = accountService.getAccountStatement(accountId, req.user);
                return sendJson(res, 200, statement);
            }

            // Match /api/accounts/:id
            const accountMatch = pathname.match(/^\/api\/accounts\/([^/]+)$/);
            if (accountMatch && method === 'GET') {
                if (!authenticate(req, res)) return;
                const accountId = accountMatch[1];
                const account = accountService.getAccountById(accountId);
                if (!account) {
                    return sendJson(res, 404, { error: 'ACCOUNT_NOT_FOUND' });
                }
                // FR-3: Ownership check
                if (req.user.role === 'ACCOUNT_HOLDER' && account.owner_id !== req.user.userId) {
                    auditService.record({
                        actorId: req.user.userId,
                        actorUsername: req.user.username,
                        actorRole: req.user.role,
                        action: 'UNAUTHORIZED_ACCOUNT_READ',
                        entityType: 'ACCOUNT',
                        entityId: accountId,
                        ipAddress,
                        status: 'UNAUTHORIZED'
                    });
                    return sendJson(res, 403, { error: 'FORBIDDEN', message: 'You can only access your own accounts' });
                }
                return sendJson(res, 200, { account });
            }

            // ----------------------------------------------------------------
            // 4. Money Movement & Transactions (FR-10, FR-11, FR-12, FR-13, FR-14, FR-16, FR-17, FR-18)
            // ----------------------------------------------------------------
            if (pathname === '/api/transactions/deposit' && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN')) return;

                const body = await parseBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
                if (!idempotencyKey) {
                    return sendJson(res, 400, { error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' });
                }

                const result = ledgerService.deposit({
                    accountId: body.accountId,
                    amount: body.amount,
                    idempotencyKey,
                    description: body.description,
                    actor: req.user
                });

                return sendJson(res, result.isCached ? 200 : 201, result);
            }

            if (pathname === '/api/transactions/withdraw' && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN')) return;

                const body = await parseBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
                if (!idempotencyKey) {
                    return sendJson(res, 400, { error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' });
                }

                const result = ledgerService.withdraw({
                    accountId: body.accountId,
                    amount: body.amount,
                    idempotencyKey,
                    description: body.description,
                    actor: req.user
                });

                return sendJson(res, result.isCached ? 200 : 201, result);
            }

            if (pathname === '/api/transactions/transfer' && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ACCOUNT_HOLDER', 'ADMIN')) return;

                const body = await parseBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
                if (!idempotencyKey) {
                    return sendJson(res, 400, { error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' });
                }

                const result = ledgerService.transfer({
                    sourceAccountId: body.sourceAccountId,
                    destinationAccountId: body.destinationAccountId,
                    destinationAccountNumber: body.destinationAccountNumber,
                    amount: body.amount,
                    idempotencyKey,
                    description: body.description,
                    actor: req.user
                });

                return sendJson(res, result.isCached ? 200 : 201, result);
            }

            if (pathname === '/api/transactions' && method === 'GET') {
                if (!authenticate(req, res)) return;
                const limit = query.limit ? parseInt(query.limit, 10) : 50;
                const offset = query.offset ? parseInt(query.offset, 10) : 0;
                const accountId = query.accountId || null;

                const transactions = ledgerService.getTransactions({
                    limit,
                    offset,
                    accountId,
                    requestingUser: req.user
                });
                return sendJson(res, 200, { transactions });
            }

            // ----------------------------------------------------------------
            // 5. Ledger & Conservation Verification (FR-14, FR-15)
            // ----------------------------------------------------------------
            if (pathname === '/api/ledger/conservation' && method === 'GET') {
                if (!authenticate(req, res)) return;
                const conservation = ledgerService.verifyConservation();
                return sendJson(res, 200, conservation);
            }

            if (pathname === '/api/ledger/entries' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'AUDITOR', 'ADMIN')) return;

                const limit = query.limit ? parseInt(query.limit, 10) : 100;
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
                sql += ' ORDER BY le.created_at DESC, le.rowid DESC LIMIT ?';
                params.push(limit);

                const entries = db.prepare(sql).all(...params);
                return sendJson(res, 200, { entries });
            }

            // ----------------------------------------------------------------
            // 6. Audit Logs (FR-19, FR-21)
            // ----------------------------------------------------------------
            if (pathname === '/api/audit/logs' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'AUDITOR', 'ADMIN')) return;

                const limit = query.limit ? parseInt(query.limit, 10) : 50;
                const offset = query.offset ? parseInt(query.offset, 10) : 0;
                const entityType = query.entityType || null;
                const actorId = query.actorId || null;
                const status = query.status || null;

                const auditData = auditService.getLogs({ limit, offset, entityType, actorId, status });
                return sendJson(res, 200, auditData);
            }

            // ----------------------------------------------------------------
            // 7. Admin User & Account Management (FR-7, FR-8, FR-9)
            // ----------------------------------------------------------------
            if (pathname === '/api/admin/users' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ADMIN')) return;

                const users = adminService.listUsers({
                    status: query.status || null,
                    role: query.role || null
                });
                return sendJson(res, 200, { users });
            }

            if (pathname === '/api/admin/users' && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ADMIN')) return;

                const body = await parseBody(req);
                const result = adminService.createUser(body, req.user);
                return sendJson(res, 201, result);
            }

            const activateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/activate$/);
            if (activateMatch && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ADMIN')) return;

                const targetUserId = activateMatch[1];
                const result = adminService.activateUser(targetUserId, req.user);
                return sendJson(res, 200, result);
            }

            const deactivateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/deactivate$/);
            if (deactivateMatch && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ADMIN')) return;

                const targetUserId = deactivateMatch[1];
                const result = adminService.deactivateUser(targetUserId, req.user);
                return sendJson(res, 200, result);
            }

            const accountStatusMatch = pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/status$/);
            if (accountStatusMatch && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ADMIN')) return;

                const accountId = accountStatusMatch[1];
                const body = await parseBody(req);
                const account = accountService.updateAccountStatus(accountId, body.status, req.user);
                return sendJson(res, 200, { account });
            }

            if (pathname === '/api/admin/stats' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ADMIN')) return;

                const stats = adminService.getSystemStats();
                return sendJson(res, 200, { stats });
            }

            if (pathname === '/api/admin/reset-seed' && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!authorizeRole(req, res, 'ADMIN')) return;

                resetAndSeedDatabase(db, req.user);
                return sendJson(res, 200, { message: 'Demo balances and users reset to baseline; immutable audit trail preserved.' });
            }

            // ----------------------------------------------------------------
            // 8. Static Frontend Serving (FR-22) with path traversal guard
            // ----------------------------------------------------------------
            const publicDir = path.resolve(__dirname, '..', '..', 'frontend');
            const requestedRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
            const filePath = path.resolve(publicDir, requestedRel);

            if (filePath.startsWith(publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes = {
                    '.html': 'text/html',
                    '.js': 'text/javascript',
                    '.css': 'text/css',
                    '.json': 'application/json',
                    '.png': 'image/png',
                    '.svg': 'image/svg+xml'
                };
                const contentType = mimeTypes[ext] || 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': contentType });
                fs.createReadStream(filePath).pipe(res);
                return;
            }

            // Fallback 404
            return sendJson(res, 404, {
                error: 'NOT_FOUND',
                message: `Route '${method} ${pathname}' not found`
            });

        } catch (err) {
            if (err.message === 'UNAUTHORIZED_ACCOUNT_ACCESS') {
                auditService.record({
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
                'CANNOT_DEACTIVATE_OWN_ADMIN_ACCOUNT': 400,
                'INSUFFICIENT_FUNDS': 400,
                'ACCOUNT_NOT_ACTIVE': 400,
                'USER_NOT_ACTIVE': 400,
                'INVALID_CREDENTIALS': 401,
                'ACCOUNT_PENDING_APPROVAL': 403,
                'ACCOUNT_DEACTIVATED': 403,
                'UNAUTHORIZED_ACCOUNT_ACCESS': 403,
                'FORBIDDEN_SELF_REGISTRATION_ROLE': 403,
                'CANNOT_MODIFY_SYSTEM_CLEARING_ACCOUNT': 403,
                'CANNOT_DEACTIVATE_SYSTEM_ROOT': 403,
                'FORBIDDEN': 403,
                'ACCOUNT_NOT_FOUND': 404,
                'SOURCE_ACCOUNT_NOT_FOUND': 404,
                'DESTINATION_ACCOUNT_NOT_FOUND': 404,
                'USER_NOT_FOUND': 404,
                'USER_ALREADY_EXISTS': 409,
                'ADMIN_ALREADY_BOOTSTRAPPED': 409,
                'CONCURRENT_TRANSACTION_IN_PROGRESS': 409,
                'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH': 422
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

    return server;
}

if (require.main === module) {
    const server = createServer();
    server.listen(config.PORT, () => {
        console.log(`====================================================`);
        console.log(` LedgerLine / BalanceVault Core API Running`);
        console.log(` Port:    http://localhost:${config.PORT}`);
        console.log(` Health:  http://localhost:${config.PORT}/api/health`);
        console.log(` Ready:   http://localhost:${config.PORT}/api/ready`);
        console.log(`====================================================`);
    });
}

module.exports = { createServer };
