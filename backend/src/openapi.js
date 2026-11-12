// backend/src/openapi.js
function buildOpenApiSpec() {
    return {
        openapi: '3.0.3',
        info: {
            title: 'LedgerLine / BalanceVault API',
            version: '1.1.0',
            description:
                'Provably balanced double-entry financial ledger API with minor-unit integer precision, serialized ACID locks, idempotent replay protection, append-only hash-chained auditing, and strict RBAC.'
        },
        servers: [{ url: '/api', description: 'Same-origin REST API' }],
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT'
                }
            }
        },
        paths: {
            '/health': { get: { summary: 'Public liveness probe', responses: { '200': { description: 'Service UP' } } } },
            '/ready': { get: { summary: 'Database and rate-limiter readiness probe', responses: { '200': { description: 'Service READY' } } } },
            '/metrics': {
                get: {
                    summary: 'Runtime telemetry & request latency snapshot (ADMIN/AUDITOR)',
                    security: [{ BearerAuth: [] }],
                    responses: { '200': { description: 'Telemetry metrics JSON' }, '403': { description: 'Forbidden' } }
                }
            },
            '/events/stream': {
                get: {
                    summary: 'RBAC-filtered real-time Server-Sent Events (SSE) ledger & audit feed',
                    security: [{ BearerAuth: [] }],
                    responses: { '200': { description: 'text/event-stream' } }
                }
            },
            '/auth/login': {
                post: {
                    summary: 'Authenticate ACTIVE user with lockout protection',
                    responses: { '200': { description: 'JWT & user payload' }, '429': { description: 'Rate limit or lockout active' } }
                }
            },
            '/auth/logout': {
                post: {
                    summary: 'Revoke active JWT server-side via jti blocklist',
                    security: [{ BearerAuth: [] }],
                    responses: { '200': { description: 'Signed out cleanly' } }
                }
            },
            '/auth/change-password': {
                post: {
                    summary: 'Rotate password, revoke old JWT, issue fresh token',
                    security: [{ BearerAuth: [] }],
                    responses: { '200': { description: 'Rotated JWT returned' } }
                }
            },
            '/auth/register': { post: { summary: 'Self-register ACCOUNT_HOLDER (PENDING_APPROVAL)' } },
            '/auth/bootstrap-status': { get: { summary: 'Check whether initial Root Admin bootstrap is needed' } },
            '/auth/bootstrap': { post: { summary: 'Create first ADMIN when none exists' } },
            '/accounts': {
                get: { summary: 'List owned accounts (or all accounts for ADMIN/AUDITOR)', security: [{ BearerAuth: [] }] },
                post: { summary: 'Open CHECKING or SAVINGS account', security: [{ BearerAuth: [] }] }
            },
            '/accounts/recipients': {
                get: { summary: 'Privacy-safe active recipient directory', security: [{ BearerAuth: [] }] }
            },
            '/accounts/{id}/statement': {
                get: { summary: 'Chronological running-balance statement with filters', security: [{ BearerAuth: [] }] }
            },
            '/accounts/{id}/statement/export': {
                get: { summary: 'Download filtered account statement as CSV', security: [{ BearerAuth: [] }] }
            },
            '/accounts/{id}/close': {
                post: { summary: 'Atomically sweep remaining balance and close account', security: [{ BearerAuth: [] }] }
            },
            '/transactions/deposit': {
                post: { summary: 'Idempotent double-entry deposit (cents)', security: [{ BearerAuth: [] }] }
            },
            '/transactions/withdraw': {
                post: { summary: 'Idempotent concurrency-safe withdrawal (cents)', security: [{ BearerAuth: [] }] }
            },
            '/transactions/transfer': {
                post: { summary: 'Idempotent atomic customer-to-customer transfer (cents)', security: [{ BearerAuth: [] }] }
            },
            '/transactions/{id}': {
                get: { summary: 'Inspect double-entry debit/credit legs & idempotency metadata', security: [{ BearerAuth: [] }] }
            },
            '/transactions/idempotency': {
                get: { summary: 'Inspect recent idempotency key states', security: [{ BearerAuth: [] }] }
            },
            '/ledger/conservation': {
                get: { summary: 'Verify global double-entry conservation invariant', security: [{ BearerAuth: [] }] }
            },
            '/ledger/entries': {
                get: { summary: 'Inspect raw double-entry ledger legs (ADMIN/AUDITOR)', security: [{ BearerAuth: [] }] }
            },
            '/audit/logs': {
                get: { summary: 'Query append-only audit trail (ADMIN/AUDITOR)', security: [{ BearerAuth: [] }] }
            },
            '/audit/logs/export': {
                get: { summary: 'Export filtered audit trail as CSV (ADMIN/AUDITOR)', security: [{ BearerAuth: [] }] }
            },
            '/audit/verify-chain': {
                get: { summary: 'Cryptographically verify SHA-256 hash chain over audit_logs (ADMIN/AUDITOR)', security: [{ BearerAuth: [] }] }
            },
            '/admin/users': {
                get: { summary: 'List users & lockout flags (ADMIN)', security: [{ BearerAuth: [] }] },
                post: { summary: 'Provision ACTIVE user of any role (ADMIN)', security: [{ BearerAuth: [] }] }
            },
            '/admin/users/{id}/activate': {
                post: { summary: 'Approve/activate user and clear lockout (ADMIN)', security: [{ BearerAuth: [] }] }
            },
            '/admin/users/{id}/deactivate': {
                post: { summary: 'Deactivate user (ADMIN)', security: [{ BearerAuth: [] }] }
            },
            '/admin/accounts/{id}/status': {
                post: { summary: 'Set account status ACTIVE/FROZEN/CLOSED (ADMIN)', security: [{ BearerAuth: [] }] }
            },
            '/admin/stats': {
                get: { summary: 'Platform operational metrics (ADMIN)', security: [{ BearerAuth: [] }] }
            },
            '/admin/reset-seed': {
                post: { summary: 'Reset demo operational state while preserving audit_logs (ADMIN)', security: [{ BearerAuth: [] }] }
            }
        }
    };
}

module.exports = { buildOpenApiSpec };
