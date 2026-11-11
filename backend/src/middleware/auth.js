// backend/src/middleware/auth.js
const { verifyToken } = require('../services/authService');

function authenticate(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Bearer token missing or invalid' }));
        return false;
    }

    const token = authHeader.substring(7);
    try {
        const payload = verifyToken(token);
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

