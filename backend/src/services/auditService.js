// backend/src/services/auditService.js
const crypto = require('node:crypto');

class AuditService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Record an append-only audit event.
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
        const id = 'aud_' + crypto.randomUUID();
        const detailsString = typeof details === 'object' && details !== null
            ? JSON.stringify(details)
            : details;

        await this.db.run(`
            INSERT INTO audit_logs (
                id, actor_id, actor_username, actor_role,
                action, entity_type, entity_id, details,
                ip_address, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            id, actorId, actorUsername, actorRole,
            action, entityType, entityId, detailsString,
            ipAddress, status
        );
        return id;
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
                   ip_address, status, created_at
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

module.exports = { AuditService };
