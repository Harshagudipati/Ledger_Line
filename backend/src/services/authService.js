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

function generateToken(payload, expiresInHours = config.TOKEN_EXPIRY_HOURS) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + (expiresInHours * 3600);
    const jti = 'jti_' + crypto.randomUUID();
    const enrichedPayload = { ...payload, jti, exp, iat };

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

    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        throw new Error('INVALID_TOKEN_SIGNATURE');
    }

    let header;
    let payload;
    try {
        header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        throw new Error('INVALID_TOKEN_FORMAT');
    }

    if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') {
        throw new Error('INVALID_TOKEN_FORMAT');
    }
    if (!payload || typeof payload !== 'object' || !payload.userId || !payload.role) {
        throw new Error('INVALID_TOKEN_FORMAT');
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
        throw new Error('TOKEN_EXPIRED');
    }

    return payload;
}

function validateUserInput({ username, email, password }) {
    const cleanUsername = typeof username === 'string' ? username.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!cleanUsername || !cleanEmail || !password) {
        throw new Error('MISSING_FIELDS');
    }
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) {
        throw new Error('INVALID_USERNAME');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        throw new Error('INVALID_EMAIL');
    }
    if (typeof password !== 'string' || password.length < 8) {
        throw new Error('PASSWORD_TOO_SHORT');
    }
    return { username: cleanUsername, email: cleanEmail, password };
}

class AuthService {
    constructor(db) {
        this.db = db;
    }

    /**
     * FR-6: Public Account-Holder Self-Registration.
     * New holders are placed in PENDING_APPROVAL until an Admin activates them.
     */
    async register({ username, email, password, role = 'ACCOUNT_HOLDER' }) {
        if (role !== 'ACCOUNT_HOLDER') {
            throw new Error('FORBIDDEN_SELF_REGISTRATION_ROLE');
        }
        const validated = validateUserInput({ username, email, password });

        const existing = await this.db.get(
            'SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)',
            validated.username,
            validated.email
        );
        if (existing) {
            throw new Error('USER_ALREADY_EXISTS');
        }

        const id = 'usr_' + crypto.randomUUID();
        const { hash, salt } = hashPassword(validated.password);

        await this.db.run(`
            INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL')
        `, id, validated.username, validated.email, hash, salt, 'ACCOUNT_HOLDER');

        return {
            id,
            username: validated.username,
            email: validated.email,
            role: 'ACCOUNT_HOLDER',
            status: 'PENDING_APPROVAL'
        };
    }

    /**
     * FR-4: First-Admin Bootstrap Process.
     * Succeeds ONLY if no non-system ADMIN user exists in the database.
     */
    async bootstrapAdmin({ username, email, password }) {
        const validated = validateUserInput({ username, email, password });

        return this.db.withTransaction(async (txDb) => {
            const existingAdmin = await txDb.get(
                "SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN' AND id != ?",
                config.SYSTEM_USER_ID
            );
            if (Number(existingAdmin.count) > 0) {
                throw new Error('ADMIN_ALREADY_BOOTSTRAPPED');
            }

            const existingUser = await txDb.get(
                'SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)',
                validated.username,
                validated.email
            );
            if (existingUser) {
                throw new Error('USER_ALREADY_EXISTS');
            }

            const id = 'usr_' + crypto.randomUUID();
            const { hash, salt } = hashPassword(validated.password);

            await txDb.run(`
                INSERT INTO users (id, username, email, password_hash, password_salt, role, status)
                VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE')
            `, id, validated.username, validated.email, hash, salt);

            return {
                id,
                username: validated.username,
                email: validated.email,
                role: 'ADMIN',
                status: 'ACTIVE'
            };
        });
    }

    /**
     * FR-1: Secure Authentication with lockout protection against brute-force logins.
     */
    async login({ username, password }) {
        if (!username || !password) {
            throw new Error('MISSING_CREDENTIALS');
        }

        const user = await this.db.get('SELECT * FROM users WHERE username = ?', username);
        if (!user) {
            throw new Error('INVALID_CREDENTIALS');
        }

        if (user.locked_until) {
            const lockExpiry = new Date(user.locked_until).getTime();
            if (!Number.isNaN(lockExpiry) && lockExpiry > Date.now()) {
                throw new Error('ACCOUNT_TEMPORARILY_LOCKED');
            }
            // Expired lock clears cleanly
            await this.db.run(
                'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
                user.id
            );
            user.failed_login_attempts = 0;
        }

        const isValid = verifyPassword(password, user.password_hash, user.password_salt);
        if (!isValid) {
            const nextAttempts = Number(user.failed_login_attempts || 0) + 1;
            const shouldLock = nextAttempts >= config.MAX_FAILED_LOGINS;
            const lockedUntil = shouldLock
                ? new Date(Date.now() + config.LOCKOUT_DURATION_MS).toISOString()
                : null;

            await this.db.run(`
                UPDATE users
                SET failed_login_attempts = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, nextAttempts, lockedUntil, user.id);

            throw new Error(shouldLock ? 'ACCOUNT_TEMPORARILY_LOCKED' : 'INVALID_CREDENTIALS');
        }

        if (user.status === 'PENDING_APPROVAL') {
            throw new Error('ACCOUNT_PENDING_APPROVAL');
        }
        if (user.status === 'DEACTIVATED') {
            throw new Error('ACCOUNT_DEACTIVATED');
        }
        if (user.status !== 'ACTIVE') {
            throw new Error('USER_NOT_ACTIVE');
        }

        if (Number(user.failed_login_attempts || 0) > 0 || user.locked_until) {
            await this.db.run(
                'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
                user.id
            );
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

    /**
     * Server-side session logout: persists the JWT `jti` into `revoked_tokens`.
     */
    async revokeToken({ jti, userId, exp }) {
        if (!jti || !userId) return false;
        const expiresAt = exp
            ? new Date(exp * 1000).toISOString()
            : new Date(Date.now() + config.TOKEN_EXPIRY_HOURS * 3600 * 1000).toISOString();

        await this.db.run(`
            INSERT INTO revoked_tokens (jti, user_id, expires_at)
            VALUES (?, ?, ?)
            ON CONFLICT(jti) DO NOTHING
        `, jti, userId, expiresAt);

        // Best-effort opportunistic purge of expired revocations
        await this.db.run('DELETE FROM revoked_tokens WHERE expires_at < ?', new Date().toISOString());
        return true;
    }

    async isTokenRevoked(jti) {
        if (!jti) return false;
        const row = await this.db.get('SELECT jti FROM revoked_tokens WHERE jti = ?', jti);
        return Boolean(row);
    }

    /**
     * Authenticated self-service password rotation; revokes previous token & issues a fresh one.
     */
    async changePassword({ userId, currentPassword, newPassword, currentJti = null, currentExp = null }) {
        if (!currentPassword || !newPassword) {
            throw new Error('MISSING_FIELDS');
        }
        if (String(newPassword).length < 8) {
            throw new Error('PASSWORD_TOO_SHORT');
        }

        const user = await this.db.get('SELECT * FROM users WHERE id = ?', userId);
        if (!user) {
            throw new Error('USER_NOT_FOUND');
        }

        const matches = verifyPassword(currentPassword, user.password_hash, user.password_salt);
        if (!matches) {
            throw new Error('INVALID_CURRENT_PASSWORD');
        }

        const { hash, salt } = hashPassword(newPassword);
        await this.db.run(`
            UPDATE users
            SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, hash, salt, userId);

        if (currentJti) {
            await this.revokeToken({ jti: currentJti, userId, exp: currentExp });
        }

        const freshToken = generateToken({
            userId: user.id,
            username: user.username,
            role: user.role
        });

        return {
            message: 'Password updated successfully.',
            token: freshToken
        };
    }
}

module.exports = {
    AuthService,
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    validateUserInput
};
