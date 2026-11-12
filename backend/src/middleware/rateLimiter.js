// backend/src/middleware/rateLimiter.js
const net = require('node:net');
const tls = require('node:tls');
const config = require('../config');

/**
 * Lightweight zero-dependency RESP2 command runner for Redis (`REDIS_URL`).
 * Sends pipeline commands and parses simple/integer/bulk responses cleanly.
 */
function executeRedisCommands(redisUrl, commands, timeoutMs = 500) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(redisUrl);
        const useTls = parsed.protocol === 'rediss:';
        const host = parsed.hostname || '127.0.0.1';
        const port = parsed.port ? parseInt(parsed.port, 10) : 6379;
        const password = parsed.password ? decodeURIComponent(parsed.password) : null;
        const username = parsed.username ? decodeURIComponent(parsed.username) : null;
        const dbIndex = parsed.pathname && parsed.pathname.length > 1 ? parseInt(parsed.pathname.slice(1), 10) : 0;

        const fullPipeline = [];
        if (password) {
            fullPipeline.push(username ? ['AUTH', username, password] : ['AUTH', password]);
        }
        if (dbIndex > 0 && !Number.isNaN(dbIndex)) {
            fullPipeline.push(['SELECT', String(dbIndex)]);
        }
        const userCmdOffset = fullPipeline.length;
        fullPipeline.push(...commands);

        const payload = fullPipeline
            .map(args => {
                const lines = [`*${args.length}`];
                for (const a of args) {
                    const s = String(a);
                    lines.push(`$${Buffer.byteLength(s)}`, s);
                }
                return lines.join('\r\n') + '\r\n';
            })
            .join('');

        const socket = useTls
            ? tls.connect({ host, port, rejectUnauthorized: process.env.NODE_ENV === 'production' })
            : net.createConnection({ host, port });

        let raw = '';
        let done = false;

        const finish = (err, val) => {
            if (done) return;
            done = true;
            socket.destroy();
            if (err) reject(err);
            else resolve(val);
        };

        socket.setTimeout(timeoutMs, () => finish(new Error('REDIS_TIMEOUT')));
        socket.on('error', err => finish(err));

        socket.on('connect', () => {
            socket.write(payload);
        });

        socket.on('data', chunk => {
            raw += chunk.toString('utf8');
            const parsedReplies = tryParseRespReplies(raw, fullPipeline.length);
            if (parsedReplies) {
                finish(null, parsedReplies.slice(userCmdOffset));
            }
        });
    });
}

function tryParseRespReplies(buffer, expectedCount) {
    const replies = [];
    let pos = 0;

    while (pos < buffer.length && replies.length < expectedCount) {
        const lineEnd = buffer.indexOf('\r\n', pos);
        if (lineEnd === -1) return null;

        const prefix = buffer[pos];
        const line = buffer.slice(pos + 1, lineEnd);

        if (prefix === '+' || prefix === '-' || prefix === ':') {
            if (prefix === '-') return null; // Will trigger caller error handling if needed
            replies.push(prefix === ':' ? parseInt(line, 10) : line);
            pos = lineEnd + 2;
        } else if (prefix === '$') {
            const len = parseInt(line, 10);
            if (len === -1) {
                replies.push(null);
                pos = lineEnd + 2;
            } else {
                const start = lineEnd + 2;
                if (buffer.length < start + len + 2) return null;
                replies.push(buffer.slice(start, start + len));
                pos = start + len + 2;
            }
        } else {
            return null;
        }
    }

    return replies.length >= expectedCount ? replies : null;
}

/**
 * Sliding-window Rate Limiter (FR-5).
 * Supports distributed Redis (`REDIS_URL`) with automatic graceful in-memory fallback.
 */
class RateLimiter {
    constructor({ windowMs = 60000, max = 500, redisUrl = config.REDIS_URL, prefix = 'rl' } = {}) {
        this.windowMs = windowMs;
        this.max = max;
        this.redisUrl = redisUrl || null;
        this.prefix = prefix;
        this.store = new Map();
        this.backendMode = this.redisUrl ? 'redis' : 'memory';

        this.cleanupInterval = setInterval(() => this.cleanup(), Math.max(10000, this.windowMs));
        if (this.cleanupInterval.unref) {
            this.cleanupInterval.unref();
        }
    }

    cleanup() {
        const now = Date.now();
        for (const [key, record] of this.store.entries()) {
            if (now > record.resetTime) {
                this.store.delete(key);
            }
        }
    }

    reset() {
        this.store.clear();
    }

    getBackendMode() {
        return this.backendMode;
    }

    _consumeMemory(key) {
        const now = Date.now();
        let record = this.store.get(key);

        if (!record || now > record.resetTime) {
            record = {
                count: 1,
                resetTime: now + this.windowMs
            };
            this.store.set(key, record);
            return { allowed: true, remaining: Math.max(0, this.max - 1), retryAfterSeconds: 0 };
        }

        if (record.count >= this.max) {
            const retryAfterSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
            return { allowed: false, remaining: 0, retryAfterSeconds };
        }

        record.count++;
        return {
            allowed: true,
            remaining: Math.max(0, this.max - record.count),
            retryAfterSeconds: 0
        };
    }

    async check(req, res, key) {
        const bucketKey = `${this.prefix}:${key}`;
        let decision = null;

        if (this.redisUrl) {
            try {
                const redisKey = `ledgerline:${bucketKey}`;
                const [count, pttl] = await executeRedisCommands(this.redisUrl, [
                    ['INCR', redisKey],
                    ['PTTL', redisKey]
                ]);

                if (pttl < 0) {
                    await executeRedisCommands(this.redisUrl, [['PEXPIRE', redisKey, String(this.windowMs)]]);
                }

                this.backendMode = 'redis';
                if (count > this.max) {
                    const ttlMs = pttl > 0 ? pttl : this.windowMs;
                    decision = {
                        allowed: false,
                        remaining: 0,
                        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000))
                    };
                } else {
                    decision = {
                        allowed: true,
                        remaining: Math.max(0, this.max - count),
                        retryAfterSeconds: 0
                    };
                }
            } catch {
                this.backendMode = 'memory-fallback';
                decision = this._consumeMemory(bucketKey);
            }
        } else {
            this.backendMode = 'memory';
            decision = this._consumeMemory(bucketKey);
        }

        res.setHeader('X-RateLimit-Limit', String(this.max));
        res.setHeader('X-RateLimit-Remaining', String(decision.remaining));

        if (!decision.allowed) {
            res.setHeader('Retry-After', String(decision.retryAfterSeconds));
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'RATE_LIMIT_EXCEEDED',
                message: `Too many requests. Try again in ${decision.retryAfterSeconds} seconds.`
            }));
            return false;
        }

        return true;
    }
}

module.exports = { RateLimiter };
