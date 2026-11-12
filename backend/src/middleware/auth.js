// backend/src/middleware/auth.js
const { verifyToken } = require('../services/authService');

async function authenticate(req, res, db = null) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Bearer token missing or invalid' }));
        return false;
    }

    const token = authHeader.substring(7);
    try {
        const payload = verifyToken(token);

        if (db) {
            if (payload.jti) {
                const revoked = await db.get('SELECT jti FROM revoked_tokens WHERE jti = ?', payload.jti);
                if (revoked) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'TOKEN_REVOKED', message: 'Session has been signed out or revoked' }));
                    return false;
                }
            }

            const userRow = await db.get('SELECT status, role FROM users WHERE id = ?', payload.userId);
            if (!userRow) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'User session no longer exists' }));
                return false;
            }
            if (userRow.status !== 'ACTIVE') {
                const code = userRow.status === 'DEACTIVATED' ? 'ACCOUNT_DEACTIVATED' : 'ACCOUNT_PENDING_APPROVAL';
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: code, message: `Access blocked: user status is ${userRow.status}` }));
                return false;
            }

            req.user = { ...payload, role: userRow.role };
            return true;
        }

        req.user = payload;
        return true;
    } catch (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: err.message }));
        return false;
    }
}

function requireRole(...allowedRoles) {
    return (req, res) => {
        if (!req.user) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Authentication required' }));
            return false;
        }

        if (!allowedRoles.includes(req.user.role)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'FORBIDDEN',
                message: `User role '${req.user.role}' lacks permission. Required: [${allowedRoles.join(', ')}]`
            }));
            return false;
        }

        return true;
    };
}

module.exports = {
    authenticate,
    requireRole
};
