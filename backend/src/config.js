// backend/src/config.js
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Lightweight zero-dependency .env loader (does not overwrite existing process.env vars)
function loadDotEnv() {
    const envPath = path.join(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!(key in process.env)) {
            process.env[key] = val;
        }
    }
}

loadDotEnv();

const NODE_ENV = process.env.NODE_ENV || 'development';

if (NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'replace-with-random-64-char-hex-secret' || process.env.JWT_SECRET.length < 32) {
        throw new Error('FATAL: A strong JWT_SECRET (>= 32 chars) must be set when NODE_ENV=production.');
    }
}

// Per-process cryptographic fallback for local dev/test; never a static hardcoded repo secret.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

module.exports = {
    NODE_ENV,
    PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 8080,
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'ledgerline.sqlite'),
    DATABASE_URL: process.env.DATABASE_URL || null,
    REDIS_URL: process.env.REDIS_URL || null,
    TRUST_PROXY: process.env.TRUST_PROXY === 'true',
    CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
    JWT_SECRET,
    TOKEN_EXPIRY_HOURS: 12,
    RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
    AUTH_RATE_LIMIT_MAX: process.env.AUTH_RATE_LIMIT_MAX ? parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) : 30,
    RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) : 500,
    MAX_FAILED_LOGINS: process.env.MAX_FAILED_LOGINS ? parseInt(process.env.MAX_FAILED_LOGINS, 10) : 5,
    LOCKOUT_DURATION_MS: process.env.LOCKOUT_DURATION_MS ? parseInt(process.env.LOCKOUT_DURATION_MS, 10) : 15 * 60 * 1000,
    SEED_DEMO_USERS: process.env.SEED_DEMO_USERS !== 'false' && NODE_ENV !== 'production',
    QUIET_LOGS: process.env.QUIET_LOGS === 'true' || NODE_ENV === 'test',
    SYSTEM_CLEARING_ACCOUNT_ID: 'acc_system_clearing_vault',
    SYSTEM_USER_ID: 'usr_system_root'
};
