// backend/src/db/migrate.js
const fs = require('node:fs');
const path = require('node:path');
const { initDatabase } = require('./database');

async function runMigrations(dbInstance = null) {
    const db = dbInstance || await initDatabase();
    const isPg = db.dialect === 'postgres';

    await db.exec(
        isPg
            ? `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`
            : `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`
    );

    const schemaFile = isPg ? 'schema.postgres.sql' : 'schema.sql';
    const fullSchema = fs.readFileSync(path.join(__dirname, schemaFile), 'utf8');

    const migrationKey = `001_baseline_${db.dialect}`;
    const already = await db.get('SELECT version FROM schema_migrations WHERE version = ?', migrationKey);
    if (!already) {
        await db.exec(fullSchema);
        await db.run('INSERT INTO schema_migrations (version) VALUES (?)', migrationKey);
        console.log(`✓ Applied migration ${migrationKey}`);
    } else {
        console.log(`✓ Migration ${migrationKey} already applied`);
    }

    if (isPg && process.env.APPLY_PG_ROLES === 'true') {
        const rolesSql = fs.readFileSync(path.join(__dirname, 'postgresRoles.sql'), 'utf8');
        await db.exec(rolesSql);
        console.log('✓ Applied least-privilege PostgreSQL roles (FR-4 / FR-24)');
    }

    return db;
}

if (require.main === module) {
    runMigrations()
        .then(async (db) => {
            await db.close();
            process.exit(0);
        })
        .catch((err) => {
            console.error('Migration failed:', err);
            process.exit(1);
        });
}

module.exports = { runMigrations };
