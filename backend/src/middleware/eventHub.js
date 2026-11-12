// backend/src/middleware/eventHub.js
const crypto = require('node:crypto');

class EventHub {
    constructor() {
        this.clients = new Set();
        this.heartbeatTimer = setInterval(() => {
            for (const client of this.clients) {
                try {
                    client.res.write(': ping\n\n');
                } catch (_) {
                    this.clients.delete(client);
                }
            }
        }, 25000);
        if (typeof this.heartbeatTimer.unref === 'function') {
            this.heartbeatTimer.unref();
        }
    }

    subscribe(req, res, user) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });

        const client = {
            id: crypto.randomUUID(),
            res,
            userId: user.userId,
            role: user.role
        };
        this.clients.add(client);

        this.sendToClient(client, 'system:connected', {
            clientId: client.id,
            role: client.role,
            connectedAt: new Date().toISOString()
        });

        req.on('close', () => {
            this.clients.delete(client);
        });

        return client.id;
    }

    sendToClient(client, eventName, data) {
        try {
            const payload = JSON.stringify({
                event: eventName,
                timestamp: new Date().toISOString(),
                data
            });
            client.res.write(`event: ${eventName}\ndata: ${payload}\n\n`);
        } catch (_) {
            this.clients.delete(client);
        }
    }

    /**
     * Broadcast real-time events strictly enforcing RBAC privacy:
     * - ADMIN & AUDITOR receive system-wide events.
     * - ACCOUNT_HOLDER receives only events whose targetUserIds include client.userId.
     */
    publish(eventName, data, targetUserIds = []) {
        const allowedSet = Array.isArray(targetUserIds) ? new Set(targetUserIds.filter(Boolean)) : new Set();

        for (const client of this.clients) {
            if (client.role === 'ADMIN' || client.role === 'AUDITOR') {
                this.sendToClient(client, eventName, data);
            } else if (allowedSet.has(client.userId)) {
                this.sendToClient(client, eventName, data);
            }
        }
    }

    closeAll() {
        clearInterval(this.heartbeatTimer);
        for (const client of this.clients) {
            try {
                client.res.end();
            } catch (_) {}
        }
        this.clients.clear();
    }
}

module.exports = { EventHub };
