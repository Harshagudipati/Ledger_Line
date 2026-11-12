// backend/src/middleware/telemetry.js
const crypto = require('node:crypto');
const config = require('../config');

class TelemetryCollector {
    constructor() {
        this.startedAt = Date.now();
        this.totalRequests = 0;
        this.totalLatencyMs = 0;
        this.statusBuckets = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
        this.authFailures = 0;
        this.rateLimitBlocks = 0;
        this.recentRequests = [];
    }

    beginRequest(req, res) {
        const requestId = req.headers['x-request-id'] || crypto.randomUUID();
        const startNs = process.hrtime.bigint();
        res.setHeader('X-Request-Id', requestId);

        res.on('finish', () => {
            const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
            const status = res.statusCode || 200;

            this.totalRequests++;
            this.totalLatencyMs += elapsedMs;

            if (status >= 200 && status < 300) this.statusBuckets['2xx']++;
            else if (status >= 300 && status < 400) this.statusBuckets['3xx']++;
            else if (status >= 400 && status < 500) this.statusBuckets['4xx']++;
            else if (status >= 500) this.statusBuckets['5xx']++;

            if (status === 429) this.rateLimitBlocks++;
            if (status === 401 || status === 403) this.authFailures++;

            const logEntry = {
                timestamp: new Date().toISOString(),
                requestId,
                method: req.method,
                path: (req.url || '/').split('?')[0],
                statusCode: status,
                durationMs: Number(elapsedMs.toFixed(2)),
                userId: req.user?.userId || null,
                role: req.user?.role || null
            };

            this.recentRequests.push(logEntry);
            if (this.recentRequests.length > 50) {
                this.recentRequests.shift();
            }

            if (!config.QUIET_LOGS) {
                console.log(JSON.stringify(logEntry));
            }
        });

        return requestId;
    }

    getSnapshot({ dbDialect = 'sqlite', rateLimitBackend = 'memory' } = {}) {
        const mem = process.memoryUsage();
        return {
            uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
            totalRequests: this.totalRequests,
            avgLatencyMs: this.totalRequests > 0 ? Number((this.totalLatencyMs / this.totalRequests).toFixed(2)) : 0,
            statusBuckets: { ...this.statusBuckets },
            authFailures: this.authFailures,
            rateLimitBlocks: this.rateLimitBlocks,
            backends: {
                database: dbDialect,
                rateLimiter: rateLimitBackend
            },
            memoryRssMb: Number((mem.rss / (1024 * 1024)).toFixed(2)),
            recentRequests: [...this.recentRequests].slice(-10)
        };
    }
}

module.exports = { TelemetryCollector };
