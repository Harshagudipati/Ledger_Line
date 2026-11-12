// backend/src/middleware/rateLimiter.js
const config = require('../config');

class RateLimiter {
    constructor({ windowMs = config.RATE_LIMIT_WINDOW_MS, max = config.RATE_LIMIT_MAX_REQUESTS } = {}) {
        this.windowMs = windowMs;
        this.max = max;
        this.hits = new Map(); // key: ip -> array of timestamps

        // Clean up expired entries every 5 minutes
        setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
    }

    cleanup() {
        const now = Date.now();
        for (const [ip, timestamps] of this.hits.entries()) {
            const valid = timestamps.filter(t => now - t < this.windowMs);
            if (valid.length === 0) {
                this.hits.delete(ip);
            } else {
                this.hits.set(ip, valid);
            }
        }
    }

    reset() {
        this.hits.clear();
    }

    check(req, res) {
        const ip = req.socket?.remoteAddress || req.headers['x-forwarded-for'] || '127.0.0.1';
        const now = Date.now();

        let timestamps = this.hits.get(ip) || [];
        timestamps = timestamps.filter(t => now - t < this.windowMs);

        if (timestamps.length >= this.max) {
            const retryAfter = Math.max(1, Math.ceil((this.windowMs - (now - timestamps[0])) / 1000));
            res.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': String(retryAfter),
                'X-RateLimit-Limit': String(this.max),
                'X-RateLimit-Remaining': '0'
            });
            res.end(JSON.stringify({
                error: 'RATE_LIMIT_EXCEEDED',
                message: `Too many requests. Limit is ${this.max} per ${this.windowMs / 1000}s. Please retry in ${retryAfter}s.`
            }));
            return false;
        }

        timestamps.push(now);
        this.hits.set(ip, timestamps);
        res.setHeader('X-RateLimit-Limit', String(this.max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, this.max - timestamps.length)));
        return true;
    }
}

const defaultLimiter = new RateLimiter();

module.exports = {
    RateLimiter,
    defaultLimiter
};
