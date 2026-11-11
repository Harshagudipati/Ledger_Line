// backend/src/config.js
const path = require('node:path');

module.exports = {
    PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 8080,
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'ledgerline.sqlite'),
    JWT_SECRET: process.env.JWT_SECRET || 'ledgerline-super-secret-key-2026-vvit-challenge',
    TOKEN_EXPIRY_HOURS: 12,
    RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 minute
    RATE_LIMIT_MAX_REQUESTS: 100, // 100 requests per minute per IP
    SYSTEM_CLEARING_ACCOUNT_ID: 'acc_system_clearing_vault',
    SYSTEM_USER_ID: 'usr_system_root',
};
