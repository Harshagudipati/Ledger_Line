// backend/src/server.js
const http = require('node:http');
const url = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { getDatabase } = require('./db/database');
const { AuthService } = require('./services/authService');
const { AccountService } = require('./services/accountService');
const { LedgerService } = require('./services/ledgerService');
const { AuditService } = require('./services/auditService');
const { AdminService } = require('./services/adminService');
const { authenticate, requireRole } = require('./middleware/auth');
const { defaultLimiter } = require('./middleware/rateLimiter');

function createServer(dbInstance = null) {
    const db = dbInstance || getDatabase();
    const auditService = new AuditService(db);
    const authService = new AuthService(db);
    const accountService = new AccountService(db);
    const ledgerService = new LedgerService(db, auditService);
    const adminService = new AdminService(db, auditService, accountService);

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

        // Apply Rate Limiting
        if (!defaultLimiter.check(req, res)) {
            return;
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
                // Ping DB
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
                    status: 'SUCCESS'
                });
                return sendJson(res, 201, result);
            }

            if (pathname === '/api/auth/login' && method === 'POST') {
                const body = await parseBody(req);
                const result = authService.login(body);
                auditService.record({
                    actorId: result.user.id,
                    actorUsername: result.user.username,
                    actorRole: result.user.role,
                    action: 'USER_LOGIN',
                    entityType: 'AUTH',
                    entityId: result.user.id,
                    status: 'SUCCESS'
                });
                return sendJson(res, 200, result);
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
            if (pathname === '/api/accounts' && method === 'GET') {
                if (!authenticate(req, res)) return;
                const accounts = accountService.getAccountsForUser(req.user);
                return sendJson(res, 200, { accounts });
            }

            if (pathname === '/api/accounts' && method === 'POST') {
                if (!authenticate(req, res)) return;
                const body = await parseBody(req);
                
                // An account holder can only create accounts for themselves; admin can create for any user
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
                    return sendJson(res, 403, { error: 'FORBIDDEN', message: 'You can only access your own accounts' });
                }
                return sendJson(res, 200, { account });
            }

            // ----------------------------------------------------------------
            // 4. Money Movement & Transactions (FR-10, FR-11, FR-12, FR-13, FR-14, FR-16, FR-17, FR-18)
            // ----------------------------------------------------------------
            if (pathname === '/api/transactions/deposit' && method === 'POST') {
                if (!authenticate(req, res)) return;
                // Allow account holders and admins to deposit
                if (!requireRole('ACCOUNT_HOLDER', 'ADMIN')(req, res)) return;

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
                if (!requireRole('ACCOUNT_HOLDER', 'ADMIN')(req, res)) return;

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
                if (!requireRole('ACCOUNT_HOLDER', 'ADMIN')(req, res)) return;

                const body = await parseBody(req);
                const idempotencyKey = req.headers['idempotency-key'] || body.idempotencyKey;
                if (!idempotencyKey) {
                    return sendJson(res, 400, { error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required' });
                }

                const result = ledgerService.transfer({
                    sourceAccountId: body.sourceAccountId,
                    destinationAccountId: body.destinationAccountId,
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

                const transactions = ledgerService.getTransactions({ limit, offset, accountId });
                return sendJson(res, 200, { transactions });
            }

            // ----------------------------------------------------------------
            // 5. Ledger & Conservation Verification (FR-14, FR-15)
            // ----------------------------------------------------------------
            if (pathname === '/api/ledger/conservation' && method === 'GET') {
                if (!authenticate(req, res)) return;
                // Open to all authenticated roles (Admin, Auditor, Account Holder) for complete transparency
                const conservation = ledgerService.verifyConservation();
                return sendJson(res, 200, conservation);
            }

            if (pathname === '/api/ledger/entries' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!requireRole('AUDITOR', 'ADMIN')(req, res)) return;

                const limit = query.limit ? parseInt(query.limit, 10) : 100;
                const entries = db.prepare(`
                    SELECT le.id, le.transaction_id, le.account_id, le.direction, le.amount, le.created_at,
                           a.account_number, a.account_type, u.username as owner_username,
                           t.type as transaction_type, t.description
                    FROM ledger_entries le
                    JOIN accounts a ON le.account_id = a.id
                    JOIN users u ON a.owner_id = u.id
                    JOIN transactions t ON le.transaction_id = t.id
                    ORDER BY le.created_at DESC
                    LIMIT ?
                `).all(limit);

                return sendJson(res, 200, { entries });
            }

            // ----------------------------------------------------------------
            // 6. Audit Logs (FR-19, FR-21)
            // ----------------------------------------------------------------
            if (pathname === '/api/audit/logs' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!requireRole('AUDITOR', 'ADMIN')(req, res)) return;

                const limit = query.limit ? parseInt(query.limit, 10) : 50;
                const offset = query.offset ? parseInt(query.offset, 10) : 0;
                const entityType = query.entityType || null;
                const actorId = query.actorId || null;
                const status = query.status || null;

                const auditData = auditService.getLogs({ limit, offset, entityType, actorId, status });
                return sendJson(res, 200, auditData);
            }

            // ----------------------------------------------------------------
            // 7. Admin User Management & Onboarding (FR-7, FR-8)
            // ----------------------------------------------------------------
            if (pathname === '/api/admin/users' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!requireRole('ADMIN')(req, res)) return;

                const users = adminService.listUsers({
                    status: query.status || null,
                    role: query.role || null
                });
                return sendJson(res, 200, { users });
            }

            const activateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/activate$/);
            if (activateMatch && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!requireRole('ADMIN')(req, res)) return;

                const targetUserId = activateMatch[1];
                const result = adminService.activateUser(targetUserId, req.user);
                return sendJson(res, 200, result);
            }

            const deactivateMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/deactivate$/);
            if (deactivateMatch && method === 'POST') {
                if (!authenticate(req, res)) return;
                if (!requireRole('ADMIN')(req, res)) return;

                const targetUserId = deactivateMatch[1];
                const result = adminService.deactivateUser(targetUserId, req.user);
                return sendJson(res, 200, result);
            }

            if (pathname === '/api/admin/stats' && method === 'GET') {
                if (!authenticate(req, res)) return;
                if (!requireRole('ADMIN')(req, res)) return;

                const stats = adminService.getSystemStats();
                return sendJson(res, 200, { stats });
            }

            // ----------------------------------------------------------------
            // 8. Static Frontend Serving (FR-22)
            // ----------------------------------------------------------------
            const publicDir = path.join(__dirname, '..', '..', 'frontend');
            let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);

            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
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
            console.error('Server error:', err);
            const statusMap = {
                'MISSING_FIELDS': 400,
                'MISSING_CREDENTIALS': 400,
                'INVALID_ROLE': 400,
                'INVALID_AMOUNT_MUST_BE_POSITIVE_INTEGER_CENTS': 400,
                'MISSING_REQUIRED_PARAMETERS': 400,
                'CANNOT_TRANSFER_TO_SAME_ACCOUNT': 400,
                'INSUFFICIENT_FUNDS': 400,
                'ACCOUNT_NOT_ACTIVE': 400,
                'USER_NOT_ACTIVE': 400,
                'USER_ALREADY_EXISTS': 409,
                'ADMIN_ALREADY_BOOTSTRAPPED': 409,
                'INVALID_CREDENTIALS': 401,
                'ACCOUNT_PENDING_APPROVAL': 403,
                'ACCOUNT_DEACTIVATED': 403,
                'UNAUTHORIZED_ACCOUNT_ACCESS': 403,
                'FORBIDDEN': 403,
                'ACCOUNT_NOT_FOUND': 404,
                'USER_NOT_FOUND': 404,
                'CONCURRENT_TRANSACTION_IN_PROGRESS': 409,
                'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH': 422
            };

            const statusCode = statusMap[err.message] || 500;
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
