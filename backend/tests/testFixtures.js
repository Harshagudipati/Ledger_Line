/**
 * Synthetic test-only credentials used exclusively by the automated test suite.
 * Production and local environments rely on .env or random generated demo passwords.
 */
const TEST_PASSWORDS = {
    admin: 'AdminPassword123!',
    auditor: 'AuditorPassword123!',
    alice: 'AlicePassword123!',
    bob: 'BobPassword123!',
    charlie: 'CharliePassword123!',
};

module.exports = {
    TEST_PASSWORDS,
};
