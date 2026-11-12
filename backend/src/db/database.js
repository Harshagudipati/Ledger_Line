// backend/src/db/database.js
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let defaultAdapter = null;

/**
 * Convert `?` placeholders to PostgreSQL `$1, $2, ...` outside single-quoted literals.
 */
function toPgPlaceholders(sql) {
    let idx = 0;
    let inSingleQuote = false;
    let out = '';
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'" && sql[i - 1] !== '\\') {
            inSingleQuote = !inSingleQuote;
            out += ch;
        } else if (ch === '?' && !inSingleQuote) {
            idx++;
            out += `$${idx}`;
        } else {
            out += ch;
        }
    }
    return out;
}

class SqliteAdapter {
    constructor(sqliteDb) {
        this.dialect = 'sqlite';
        this.raw = sqliteDb;
        this._txTail = Promise.resolve();
    }

    async get(sql, ...params) {
        return this.raw.prepare(sql).get(...params);
    }

    async all(sql, ...params) {
        return this.raw.prepare(sql).all(...params);
    }

    async run(sql, ...params) {
        return this.raw.prepare(sql).run(...params);
    }

    async exec(sql) {
        return this.raw.exec(sql);
    }

    prepare(sql) {
        return this.raw.prepare(sql);
    }

    async lockAccountsForUpdate(accountIds) {
        if (!accountIds || accountIds.length === 0) return [];
        const sorted = [...new Set(accountIds)].sort();
        const placeholders = sorted.map(() => '?').join(', ');
        return this.all(`SELECT * FROM accounts WHERE id IN (${placeholders}) ORDER BY id ASC`, ...sorted);
    }

    orderByInsertion(alias, dir = 'ASC') {
        const d = dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return `${alias}.created_at ${d}, ${alias}.rowid ${d}`;
    }

    async withTransaction(callback) {
        // Serialize SQLite BEGIN IMMEDIATE blocks cleanly across async awaits
        const runTx = async () => {
            this.raw.exec('BEGIN IMMEDIATE;');
            try {
                const txProxy = {
                    dialect: 'sqlite',
                    raw: this.raw,
                    get: (sql, ...p) => this.get(sql, ...p),
                    all: (sql, ...p) => this.all(sql, ...p),
                    run: (sql, ...p) => this.run(sql, ...p),
                    exec: (sql) => this.exec(sql),
                    prepare: (sql) => this.prepare(sql),
                    lockAccountsForUpdate: (ids) => this.lockAccountsForUpdate(ids),
                    orderByInsertion: (alias, dir) => this.orderByInsertion(alias, dir)
                };
                const result = await callback(txProxy);
                this.raw.exec('COMMIT;');
                return result;
            } catch (err) {
                try {
                    this.raw.exec('ROLLBACK;');
                } catch (_) {}
                throw err;
            }
        };

        const next = this._txTail.then(runTx, runTx);
        this._txTail = next.catch(() => {});
        return next;
    }

    close() {
        this.raw.close();
    }
}

class PgClientTxAdapter {
    constructor(client) {
        this.dialect = 'postgres';
        this.client = client;
    }

    async get(sql, ...params) {
        const res = await this.client.query(toPgPlaceholders(sql), params);
        return res.rows[0];
    }

    async all(sql, ...params) {
        const res = await this.client.query(toPgPlaceholders(sql), params);
        return res.rows;
    }

    async run(sql, ...params) {
        const res = await this.client.query(toPgPlaceholders(sql), params);
        return { changes: res.rowCount || 0 };
    }

    async exec(sql) {
        return this.client.query(sql);
    }

    async lockAccountsForUpdate(accountIds) {
        if (!accountIds || accountIds.length === 0) return [];
        const sorted = [...new Set(accountIds)].sort();
        const placeholders = sorted.map(() => '?').join(', ');
        return this.all(`SELECT * FROM accounts WHERE id IN (${placeholders}) ORDER BY id ASC FOR UPDATE`, ...sorted);
    }

    orderByInsertion(alias, dir = 'ASC') {
        const d = dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return `${alias}.created_at ${d}, ${alias}.id ${d}`;
    }
}

class PgAdapter {
    constructor(pool) {
        this.dialect = 'postgres';
        this.pool = pool;
    }

    async get(sql, ...params) {
        const res = await this.pool.query(toPgPlaceholders(sql), params);
        return res.rows[0];
    }

    async all(sql, ...params) {
        const res = await this.pool.query(toPgPlaceholders(sql), params);
        return res.rows;
    }

    async run(sql, ...params) {
        const res = await this.pool.query(toPgPlaceholders(sql), params);
        return { changes: res.rowCount || 0 };
    }

    async exec(sql) {
        return this.pool.query(sql);
    }

    async lockAccountsForUpdate(accountIds) {
        return new PgClientTxAdapter(this.pool).lockAccountsForUpdate(accountIds);
    }

    orderByInsertion(alias, dir = 'ASC') {
        const d = dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return `${alias}.created_at ${d}, ${alias}.id ${d}`;
    }

    async withTransaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const tx = new PgClientTxAdapter(client);
            const result = await callback(tx);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {}
            throw err;
        } finally {
            client.release();
        }
    }

    async close() {
        await this.pool.end();
    }
}

function ensureSqliteMigrations(db) {
    const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!userCols.includes('failed_login_attempts')) {
        db.exec('ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;');
    }
    if (!userCols.includes('locked_until')) {
        db.exec('ALTER TABLE users ADD COLUMN locked_until TIMESTAMP;');
    }

    const auditCols = db.prepare('PRAGMA table_info(audit_logs)').all().map(c => c.name);
    if (!auditCols.includes('prev_hash')) {
        db.exec('ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT;');
    }
    if (!auditCols.includes('entry_hash')) {
        db.exec('ALTER TABLE audit_logs ADD COLUMN entry_hash TEXT;');
    }
}

function createSqliteDatabase(dbPath) {
    if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');

    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
        db.exec(fs.readFileSync(schemaPath, 'utf8'));
    }
    ensureSqliteMigrations(db);
    return new SqliteAdapter(db);
}

async function createPostgresDatabase(connectionString) {
    let pg;
    try {
        pg = require('pg');
    } catch {
        throw new Error(
            'DATABASE_URL is configured for PostgreSQL, but the `pg` package is not installed. Run `npm install pg`.'
        );
    }
    const pool = new pg.Pool({ connectionString });
    const adapter = new PgAdapter(pool);
    const pgSchemaPath = path.join(__dirname, 'schema.postgres.sql');
    if (fs.existsSync(pgSchemaPath)) {
        await adapter.exec(fs.readFileSync(pgSchemaPath, 'utf8'));
    }
    return adapter;
}

/**
 * Synchronous factory used by SQLite local/test callers.
 * When DATABASE_URL is configured for production PostgreSQL, use `initDatabase()`.
 */
function getDatabase(dbPath = config.DB_PATH, forceNew = false) {
    if (defaultAdapter && !forceNew && dbPath !== ':memory:') {
        return defaultAdapter;
    }
    const adapter = createSqliteDatabase(dbPath);
    if (dbPath !== ':memory:') {
        defaultAdapter = adapter;
    }
    return adapter;
}

async function initDatabase(dbPath = config.DB_PATH, forceNew = false) {
    if (config.DATABASE_URL && dbPath !== ':memory:') {
        if (defaultAdapter && !forceNew) return defaultAdapter;
        defaultAdapter = await createPostgresDatabase(config.DATABASE_URL);
        return defaultAdapter;
    }
    return getDatabase(dbPath, forceNew);
}

async function withTransaction(db, callback) {
    return db.withTransaction(callback);
}

function resetDatabaseInstance() {
    if (defaultAdapter) {
        try {
            defaultAdapter.close();
        } catch (_) {}
        defaultAdapter = null;
    }
}

module.exports = {
    getDatabase,
    initDatabase,
    withTransaction,
    resetDatabaseInstance,
    toPgPlaceholders
};
