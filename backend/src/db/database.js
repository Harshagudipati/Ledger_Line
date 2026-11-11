// backend/src/db/database.js
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let dbInstance = null;

function getDatabase(dbPath = config.DB_PATH) {
    if (dbInstance) return dbInstance;

    // Ensure directory exists if not in-memory
    if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;'); // Wait up to 5s if locked

    // Initialize Schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        db.exec(schema);
    }

    dbInstance = db;
    return db;
}

/**
 * Execute an atomic transaction with IMMEDIATE write lock.
 * This guarantees strict isolation and serializes concurrent writers,
 * completely eliminating race conditions and double-spending.
 */
function withTransaction(db, callback) {
    db.exec('BEGIN IMMEDIATE;');
    try {
        const result = callback(db);
        db.exec('COMMIT;');
        return result;
    } catch (err) {
        try {
            db.exec('ROLLBACK;');
        } catch (_) {
            // Ignore rollback errors if already rolled back
        }
        throw err;
    }
}

function resetDatabaseInstance() {
    if (dbInstance) {
        try {
            dbInstance.close();
        } catch (_) {}
        dbInstance = null;
    }
}

module.exports = {
    getDatabase,
    withTransaction,
    resetDatabaseInstance
};

