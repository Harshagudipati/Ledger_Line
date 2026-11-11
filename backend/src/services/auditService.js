// backend/src/services/auditService.js
const crypto = require('node:crypto');

class AuditService {
    constructor(db) {
        this.db = db;
    }

    /**
     * Record an append-only audit event.
     */
    record({
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

        try {
            this.db.prepare(`
                INSERT INTO audit_logs (
                    id, actor_id, actor_username, actor_role, 
                    action, entity_type, entity_id, details, 
                    ip_address, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id, actorId, actorUsername, actorRole,
                action, entityType, entityId, detailsString,
                ipAddress, status
            );
            return id;
        } catch (err) {
            console.error('Audit log recording failed:', err.message);
            // In financial systems, audit trail failure should be surfaced
            throw err;
        }
    }

    /**
     * Retrieve audit records with filtering and pagination.
     * Accessible only by Administrators and Auditors.
     */
    getLogs({ limit = 50, offset = 0, entityType = null, actorId = null, status = null } = {}) {
        let query = `
            SELECT id, actor_id, actor_username, actor_role,
                   action, entity_type, entity_id, details,
                   ip_address, status, created_at
            FROM audit_logs
            WHERE 1=1
        `;
        const params = [];

        if (entityType) {
            query += ' AND entity_type = ?';
            params.push(entityType);
        }
        if (actorId) {
            query += ' AND actor_id = ?';
            params.push(actorId);
        }
        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const logs = this.db.prepare(query).all(...params);
        const total = this.db.prepare('SELECT COUNT(*) as count FROM audit_logs').get().count;

        return {
            total,
            limit,
            offset,
            logs: logs.map(l => {
                let parsedDetails = l.details;
                try {
                    parsedDetails = JSON.parse(l.details);
                } catch (_) {}
                return { ...l, details: parsedDetails };
            })
        };
    }
}

module.exports = { AuditService };
