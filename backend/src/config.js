// backend/src/config.js
const path = require('node:path');

module.exports = {
    PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 8080,
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'ledgerline.sqlite'),
    JWT_SECRET: process.env.JWT_SECRET || 'ledgerline-super-secret-key-2026-vvit-challenge',
    TOKEN_EXPIRY_HOURS: 12,
    RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
    AUTH_RATE_LIMIT_MAX: process.env.AUTH_RATE_LIMIT_MAX ? parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) : 30,
    RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS ? parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) : 500,
    SYSTEM_CLEARING_ACCOUNT_ID: 'acc_system_clearing_vault',
    SYSTEM_USER_ID: 'usr_system_root',
};
