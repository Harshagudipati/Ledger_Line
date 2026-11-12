// backend/src/services/auditService.js
const crypto = require('node:crypto');

function computeAuditHash({
    prevHash,
    id,
    actorId,
    actorUsername,
    actorRole,
    action,
    entityType,
    entityId,
    detailsString,
    ipAddress,
    status
}) {
    const canonical = JSON.stringify({
        prevHash: prevHash || 'GENESIS',
        id,
        actorId: actorId ?? null,
        actorUsername: actorUsername ?? null,
        actorRole: actorRole ?? null,
        action,
        entityType,
        entityId: entityId ?? null,
        details: detailsString ?? null,
        ipAddress: ipAddress ?? null,
        status
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

class AuditService {
    constructor(db, onRecord = null) {
        this.db = db;
        this.onRecord = onRecord;
        this._chainTail = Promise.resolve();
    }

    /**
     * Record an append-only, cryptographically hash-chained audit event.
     * Serialized via an internal queue so concurrent operations produce an unbroken chain.
     */
    async record({
        actorId = null,
        actorUsername = null,
        actorRole = null,
        action,
        entityType,
        entityId = null,
        details = null,
        ipAddress = null,
        status = 'SUCCESS'
    }) {
        const writeTask = async () => {
            const id = 'aud_' + crypto.randomUUID();
            const detailsString = typeof details === 'object' && details !== null
                ? JSON.stringify(details)
                : (details ?? null);

            const latest = await this.db.get(`
                SELECT entry_hash
                FROM audit_logs
                WHERE entry_hash IS NOT NULL
                ORDER BY ${this.db.orderByInsertion('audit_logs', 'DESC')}
                LIMIT 1
            `);
            const prevHash = latest?.entry_hash || 'GENESIS';
            const entryHash = computeAuditHash({
                prevHash,
                id,
                actorId,
                actorUsername,
                actorRole,
                action,
                entityType,
                entityId,
                detailsString,
                ipAddress,
                status
            });

            await this.db.run(`
                INSERT INTO audit_logs (
                    id, actor_id, actor_username, actor_role,
                    action, entity_type, entity_id, details,
                    ip_address, status, prev_hash, entry_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
                id, actorId, actorUsername, actorRole,
                action, entityType, entityId, detailsString,
                ipAddress, status, prevHash, entryHash
            );

            if (typeof this.onRecord === 'function') {
                try {
                    this.onRecord({
                        id,
                        actorId,
                        actorUsername,
                        actorRole,
                        action,
                        entityType,
                        entityId,
                        status,
                        entryHash,
                        createdAt: new Date().toISOString()
                    });
                } catch (_) {}
            }

            return id;
        };

        const run = this._chainTail.then(writeTask, writeTask);
        this._chainTail = run.catch(() => {});
        return run;
    }

    /**
     * Walk audit_logs chronologically and mathematically verify every SHA-256 hash link.
     */
    async verifyHashChain() {
        const rows = await this.db.all(`
            SELECT id, actor_id, actor_username, actor_role, action, entity_type,
                   entity_id, details, ip_address, status, prev_hash, entry_hash, created_at
            FROM audit_logs
            ORDER BY ${this.db.orderByInsertion('audit_logs', 'ASC')}
        `);

        let expectedPrev = 'GENESIS';
        let verifiedEntries = 0;
        let legacyUnchainedEntries = 0;

        for (const row of rows) {
            if (!row.entry_hash && !row.prev_hash) {
                legacyUnchainedEntries++;
                continue;
            }

            if (row.prev_hash !== expectedPrev) {
                return {
                    valid: false,
                    totalEntries: rows.length,
                    verifiedEntries,
                    legacyUnchainedEntries,
                    headHash: expectedPrev,
                    brokenAtId: row.id,
                    reason: `PREV_HASH_MISMATCH at ${row.id}`
                };
            }

            const recomputed = computeAuditHash({
                prevHash: row.prev_hash,
                id: row.id,
                actorId: row.actor_id,
                actorUsername: row.actor_username,
                actorRole: row.actor_role,
                action: row.action,
                entityType: row.entity_type,
                entityId: row.entity_id,
                detailsString: row.details,
                ipAddress: row.ip_address,
                status: row.status
            });

            if (recomputed !== row.entry_hash) {
                return {
                    valid: false,
                    totalEntries: rows.length,
                    verifiedEntries,
                    legacyUnchainedEntries,
                    headHash: expectedPrev,
                    brokenAtId: row.id,
                    reason: `ENTRY_HASH_MISMATCH at ${row.id}`
                };
            }

            expectedPrev = row.entry_hash;
            verifiedEntries++;
        }

        return {
            valid: true,
            totalEntries: rows.length,
            verifiedEntries,
            legacyUnchainedEntries,
            headHash: expectedPrev,
            brokenAtId: null,
            reason: null
        };
    }

    /**
     * Retrieve audit records with filtering and pagination (Admin & Auditor only).
     */
    async getLogs({
        limit = 50,
        offset = 0,
        entityType = null,
        actorId = null,
        status = null,
        action = null,
        search = null,
        fromDate = null,
        toDate = null
    } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 1000);
        const safeOffset = Math.max(Number(offset) || 0, 0);

        let where = ' WHERE 1=1';
        const params = [];

        if (entityType) {
            where += ' AND entity_type = ?';
            params.push(entityType);
        }
        if (actorId) {
            where += ' AND actor_id = ?';
            params.push(actorId);
        }
        if (status) {
            where += ' AND status = ?';
            params.push(status);
        }
        if (action) {
            where += ' AND action LIKE ?';
            params.push(`%${action}%`);
        }
        if (search) {
            where += ' AND (actor_username LIKE ? OR action LIKE ? OR details LIKE ? OR entity_id LIKE ?)';
            const term = `%${search}%`;
            params.push(term, term, term, term);
        }
        if (fromDate) {
            where += ' AND created_at >= ?';
            params.push(fromDate);
        }
        if (toDate) {
            where += ' AND created_at <= ?';
            params.push(toDate);
        }

        const logs = await this.db.all(`
            SELECT id, actor_id, actor_username, actor_role,
                   action, entity_type, entity_id, details,
                   ip_address, status, prev_hash, entry_hash, created_at
            FROM audit_logs
            ${where}
            ORDER BY ${this.db.orderByInsertion('audit_logs', 'DESC')}
            LIMIT ? OFFSET ?
        `, ...params, safeLimit, safeOffset);

        const totalRow = await this.db.get(`SELECT COUNT(*) as count FROM audit_logs ${where}`, ...params);

        return {
            total: Number(totalRow.count),
            limit: safeLimit,
            offset: safeOffset,
            logs: logs.map(l => {
                let parsedDetails = l.details;
                try {
                    parsedDetails = l.details ? JSON.parse(l.details) : null;
                } catch (_) {}
                return { ...l, details: parsedDetails };
            })
        };
    }
}

module.exports = { AuditService, computeAuditHash };
