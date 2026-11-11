// backend/src/services/authService.js
const crypto = require('node:crypto');
const config = require('../config');

function hashPassword(password, salt = null) {
    if (!salt) {
        salt = crypto.randomBytes(16).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
    const { hash } = hashPassword(password, storedSalt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(storedHash, 'utf8'));
}

// Lightweight, secure JWT implementation with HMAC-SHA256
function generateToken(payload, expiresInHours = config.TOKEN_EXPIRY_HOURS) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const exp = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);
    const enrichedPayload = { ...payload, exp, iat: Math.floor(Date.now() / 1000) };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(enrichedPayload)).toString('base64url');
    const signature = crypto
        .createHmac('sha256', config.JWT_SECRET)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') {
        throw new Error('NO_TOKEN_PROVIDED');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('INVALID_TOKEN_FORMAT');
    }

    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = crypto
        .createHmac('sha256', config.JWT_SECRET)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedSignature, 'utf8'))) {
        throw new Error('INVALID_TOKEN_SIGNATURE');
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
        throw new Error('TOKEN_EXPIRED');
    }

    return payload;
}

class AuthService {
    constructor(db) {
        this.db = db;
    }

    // FR-6: Account-holder self registration
    register({ username, email, password, role = 'ACCOUNT_HOLDER' }) {
        if (!username || !email || !password) {
            throw new Error('MISSING_FIELDS');
        }

        const validRoles = ['ACCOUNT_HOLDER', 'AUDITOR', 'ADMIN'];
        if (!validRoles.includes(role)) {
            throw new Error('INVALID_ROLE');
        }

        const existingUser = this.db.prepare(
            'SELECT id FROM users WHERE username = ? OR email = ?'
        ).get(username, email);

        if (existingUser) {
            throw new Error('USER_ALREADY_EXISTS');
        }

        const userId = 'usr_' + crypto.randomUUID();
        const { hash, salt } = hashPassword(password);
        
        // Account holders start in PENDING_APPROVAL unless explicitly auto-approved by admin
        // Auditors and Admins created via public register also require approval unless bootstrap
        const initialStatus = role === 'ADMIN' ? 'PENDING_APPROVAL' : 'PENDING_APPROVAL';

        this.db.prepare(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, username, email, hash, salt, role, initialStatus);

        return {
            id: userId,
            username,
            email,
            role,
            status: initialStatus,
            message: 'Registration submitted successfully. Awaiting administrator activation.'
        };
    }

    // FR-1: Secure login
    login({ username, password }) {
        if (!username || !password) {
            throw new Error('MISSING_CREDENTIALS');
        }

        const user = this.db.prepare(
            'SELECT id, username, email, password_hash, password_salt, role, status FROM users WHERE username = ?'
        ).get(username);

        if (!user) {
            throw new Error('INVALID_CREDENTIALS');
        }

        if (user.status === 'PENDING_APPROVAL') {
            throw new Error('ACCOUNT_PENDING_APPROVAL');
        }

        if (user.status === 'DEACTIVATED') {
            throw new Error('ACCOUNT_DEACTIVATED');
        }

        const isValid = verifyPassword(password, user.password_hash, user.password_salt);
        if (!isValid) {
            throw new Error('INVALID_CREDENTIALS');
        }

        const token = generateToken({
            userId: user.id,
            username: user.username,
            role: user.role
        });

        return {
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                status: user.status
            }
        };
    }

    // FR-4: First-admin bootstrap process
    bootstrapAdmin({ username = 'admin', email = 'admin@ledgerline.local', password = 'AdminPassword123!' }) {
        const adminCount = this.db.prepare(
            "SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'"
        ).get().count;

        if (adminCount > 0) {
            throw new Error('ADMIN_ALREADY_BOOTSTRAPPED');
        }

        const adminId = 'usr_admin_bootstrap';
        const { hash, salt } = hashPassword(password);

        this.db.prepare(`
            INSERT OR REPLACE INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE')
        `).run(adminId, username, email, hash, salt);

        return {
            id: adminId,
            username,
            email,
            role: 'ADMIN',
            status: 'ACTIVE',
            message: 'First administrator successfully bootstrapped.'
        };
    }
}

module.exports = {
    AuthService,
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken
};

