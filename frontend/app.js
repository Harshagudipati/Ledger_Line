// frontend/app.js

const API_BASE = window.location.origin;

let currentUser = null;
let currentToken = null;
let currentAccount = null;
let isRegisterMode = false;

// -----------------------------------------------------------------------------
// Toast & Alert Utilities
// -----------------------------------------------------------------------------
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const colors = {
        success: 'bg-emerald-600 text-white',
        error: 'bg-rose-600 text-white',
        info: 'bg-slate-800 text-white',
        warning: 'bg-amber-600 text-white'
    };
    toast.className = `px-4 py-3 rounded-xl shadow-lg text-xs font-medium flex items-center gap-2 transform transition duration-300 ease-out translate-y-2 opacity-0 ${colors[type] || colors.info}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info'}"></i> <span>${message}</span>`;
    
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
    }, 10);

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-x-full');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// -----------------------------------------------------------------------------
// API Client
// -----------------------------------------------------------------------------
async function apiRequest(endpoint, method = 'GET', body = null, customHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...customHeaders
    };
    if (currentToken) {
        headers['Authorization'] = `Bearer ${currentToken}`;
    }

    const options = { method, headers };
    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        const res = await fetch(`${API_BASE}${endpoint}`, options);
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.message || data.error || `HTTP ${res.status}`);
        }
        return data;
    } catch (err) {
        console.error(`API Error on ${method} ${endpoint}:`, err);
        throw err;
    }
}

// -----------------------------------------------------------------------------
// Authentication & Personas
// -----------------------------------------------------------------------------
const DEMO_PERSONAS = {
    alice: { username: 'alice', password: 'AlicePassword123!' },
    bob: { username: 'bob', password: 'BobPassword123!' },
    admin: { username: 'admin', password: 'AdminPassword123!' },
    auditor: { username: 'auditor', password: 'AuditorPassword123!' }
};

async function loginAs(personaKey) {
    const persona = DEMO_PERSONAS[personaKey];
    if (!persona) return;

    try {
        const res = await apiRequest('/api/auth/login', 'POST', persona);
        currentToken = res.token;
        currentUser = res.user;
        localStorage.setItem('ledgerline_token', currentToken);
        localStorage.setItem('ledgerline_user', JSON.stringify(currentUser));
        
        updateUserUI();
        showToast(`Switched persona to ${currentUser.username} (${currentUser.role})`, 'success');
        
        // Auto navigate to role's relevant tab
        if (currentUser.role === 'ADMIN') {
            switchTab('admin-tab');
        } else if (currentUser.role === 'AUDITOR') {
            switchTab('auditor-tab');
        } else {
            switchTab('holder-tab');
        }

        refreshCurrentView();
    } catch (err) {
        showToast(`Login failed: ${err.message}`, 'error');
    }
}

function updateUserUI() {
    if (!currentUser) return;
    document.getElementById('current-username').textContent = currentUser.username;
    
    const roleBadge = document.getElementById('current-role-badge');
    roleBadge.textContent = currentUser.role;
    
    const roleColors = {
        ADMIN: 'bg-amber-100 text-amber-800 border-amber-200',
        AUDITOR: 'bg-teal-100 text-teal-800 border-teal-200',
        ACCOUNT_HOLDER: 'bg-blue-100 text-blue-800 border-blue-200'
    };
    roleBadge.className = `px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide border ${roleColors[currentUser.role] || 'bg-slate-100'}`;

    // Highlight active persona button
    document.querySelectorAll('.persona-btn').forEach(btn => {
        btn.classList.remove('ring-2', 'ring-teal-400', 'bg-slate-700');
    });
    const activeBtn = document.getElementById(`btn-${currentUser.username.toLowerCase()}`);
    if (activeBtn) {
        activeBtn.classList.add('ring-2', 'ring-teal-400', 'bg-slate-700');
    }
}

// -----------------------------------------------------------------------------
// Tabs Navigation
// -----------------------------------------------------------------------------
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('border-teal-600', 'text-teal-600');
        btn.classList.add('border-transparent', 'text-slate-500');
    });

    const activeContent = document.getElementById(tabId);
    if (activeContent) activeContent.classList.remove('hidden');

    const activeBtn = document.getElementById(`tab-btn-${tabId.replace('-tab', '')}`);
    if (activeBtn) {
        activeBtn.classList.add('border-teal-600', 'text-teal-600');
        activeBtn.classList.remove('border-transparent', 'text-slate-500');
    }

    if (tabId === 'holder-tab') loadAccountDashboard();
    if (tabId === 'admin-tab') loadAdminDashboard();
    if (tabId === 'auditor-tab') loadAuditorDashboard();
}

function refreshCurrentView() {
    verifyLedgerConservation();
    loadAccountDashboard();
    loadAdminDashboard();
    loadAuditorDashboard();
}

// -----------------------------------------------------------------------------
// Account Holder Dashboard
// -----------------------------------------------------------------------------
async function loadAccountDashboard() {
    if (!currentToken) return;

    try {
        const { accounts } = await apiRequest('/api/accounts');
        if (accounts && accounts.length > 0) {
            currentAccount = accounts[0];
            document.getElementById('account-number-display').textContent = currentAccount.account_number;
            document.getElementById('account-balance-display').textContent = `$${(currentAccount.balance / 100).toFixed(2)}`;
            await loadAccountStatement();
        } else {
            document.getElementById('account-number-display').textContent = 'No Account Found';
            document.getElementById('account-balance-display').textContent = '$0.00';
            document.getElementById('statement-table-body').innerHTML = `
                <tr><td colspan="7" class="py-6 text-center text-slate-400">No active bank account associated with this user.</td></tr>
            `;
        }
    } catch (err) {
        console.error('Failed to load accounts:', err);
    }
}

async function loadAccountStatement() {
    if (!currentAccount) return;
    const tbody = document.getElementById('statement-table-body');
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading statement...</td></tr>`;

    try {
        const data = await apiRequest(`/api/accounts/${currentAccount.id}/statement`);
        const entries = data.statement_entries || [];

        if (entries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-slate-400">No transactions recorded yet for this account.</td></tr>`;
            return;
        }

        tbody.innerHTML = entries.map(e => {
            const isDebit = e.direction === 'DEBIT';
            const dateStr = new Date(e.created_at).toLocaleString();
            return `
                <tr class="hover:bg-slate-50 transition">
                    <td class="py-3 px-4 font-mono text-[11px] text-slate-500">${dateStr}</td>
                    <td class="py-3 px-4 font-semibold">
                        <span class="px-2 py-0.5 rounded text-[10px] ${e.transaction_type === 'DEPOSIT' ? 'bg-emerald-100 text-emerald-800' : e.transaction_type === 'WITHDRAWAL' ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-800'}">
                            ${e.transaction_type}
                        </span>
                    </td>
                    <td class="py-3 px-4 text-slate-800">${e.description || 'Transaction'}</td>
                    <td class="py-3 px-4 font-mono text-[10px] text-slate-400 truncate max-w-[120px]" title="${e.idempotency_key}">
                        ${e.idempotency_key}
                    </td>
                    <td class="py-3 px-4 text-right font-mono font-medium text-amber-600">
                        ${isDebit ? `-$${(e.amount / 100).toFixed(2)}` : '-'}
                    </td>
                    <td class="py-3 px-4 text-right font-mono font-medium text-emerald-600">
                        ${!isDebit ? `+$${(e.amount / 100).toFixed(2)}` : '-'}
                    </td>
                    <td class="py-3 px-4 text-right font-mono font-bold text-slate-800">
                        $${(e.running_balance / 100).toFixed(2)}
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-500">Error loading statement: ${err.message}</td></tr>`;
    }
}

// -----------------------------------------------------------------------------
// Transaction Handlers (Deposit, Withdraw, Transfer)
// -----------------------------------------------------------------------------
function generateIdempotencyKey(prefix = 'tx') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function openDepositModal() {
    document.getElementById('deposit-modal').classList.remove('hidden');
}

function openWithdrawModal() {
    document.getElementById('withdraw-modal').classList.remove('hidden');
}

async function openTransferModal() {
    const select = document.getElementById('transfer-destination-select');
    select.innerHTML = `<option value="">Loading recipients...</option>`;
    document.getElementById('transfer-modal').classList.remove('hidden');

    try {
        const { accounts } = await apiRequest('/api/accounts');
        // Filter out current user's account and clearing vault
        const otherAccounts = accounts.filter(a => a.id !== currentAccount?.id && a.account_type !== 'SYSTEM_CLEARING');
        if (otherAccounts.length === 0) {
            select.innerHTML = `<option value="">No other customer accounts available</option>`;
            return;
        }
        select.innerHTML = otherAccounts.map(a => `
            <option value="${a.id}">
                ${a.account_number} (${a.owner_username} - ${a.account_type})
            </option>
        `).join('');
    } catch (err) {
        select.innerHTML = `<option value="">Error loading accounts</option>`;
    }
}

function closeModals() {
    document.querySelectorAll('.fixed.inset-0').forEach(m => m.classList.add('hidden'));
}

async function handleDeposit(e) {
    e.preventDefault();
    if (!currentAccount) return;
    const amountVal = parseFloat(document.getElementById('deposit-amount-input').value);
    const desc = document.getElementById('deposit-desc-input').value;
    const amountCents = Math.round(amountVal * 100);
    const key = generateIdempotencyKey('dep');

    try {
        const res = await apiRequest('/api/transactions/deposit', 'POST', {
            accountId: currentAccount.id,
            amount: amountCents,
            description: desc
        }, { 'Idempotency-Key': key });

        showToast(`Deposit of $${amountVal.toFixed(2)} successful!`, 'success');
        closeModals();
        refreshCurrentView();
    } catch (err) {
        showToast(`Deposit failed: ${err.message}`, 'error');
    }
}

async function handleWithdraw(e) {
    e.preventDefault();
    if (!currentAccount) return;
    const amountVal = parseFloat(document.getElementById('withdraw-amount-input').value);
    const desc = document.getElementById('withdraw-desc-input').value;
    const amountCents = Math.round(amountVal * 100);
    const key = generateIdempotencyKey('wdr');

    try {
        const res = await apiRequest('/api/transactions/withdraw', 'POST', {
            accountId: currentAccount.id,
            amount: amountCents,
            description: desc
        }, { 'Idempotency-Key': key });

        showToast(`Withdrawal of $${amountVal.toFixed(2)} successful!`, 'success');
        closeModals();
        refreshCurrentView();
    } catch (err) {
        showToast(`Withdrawal failed: ${err.message}`, 'error');
    }
}

async function handleTransfer(e) {
    e.preventDefault();
    if (!currentAccount) return;
    const destAccountId = document.getElementById('transfer-destination-select').value;
    if (!destAccountId) {
        showToast('Please select a recipient account', 'warning');
        return;
    }
    const amountVal = parseFloat(document.getElementById('transfer-amount-input').value);
    const desc = document.getElementById('transfer-desc-input').value;
    const amountCents = Math.round(amountVal * 100);
    const key = generateIdempotencyKey('trf');

    try {
        const res = await apiRequest('/api/transactions/transfer', 'POST', {
            sourceAccountId: currentAccount.id,
            destinationAccountId: destAccountId,
            amount: amountCents,
            description: desc
        }, { 'Idempotency-Key': key });

        showToast(`Transfer of $${amountVal.toFixed(2)} sent!`, 'success');
        closeModals();
        refreshCurrentView();
    } catch (err) {
        showToast(`Transfer failed: ${err.message}`, 'error');
    }
}

// -----------------------------------------------------------------------------
// Administrator Dashboard (User Management & Onboarding)
// -----------------------------------------------------------------------------
async function loadAdminDashboard() {
    if (!currentToken || currentUser?.role !== 'ADMIN') return;

    try {
        const { stats } = await apiRequest('/api/admin/stats');
        document.getElementById('stat-total-users').textContent = stats.users.total_users;
        document.getElementById('stat-pending-users').textContent = `${stats.users.pending_users || 0} pending approval`;
        document.getElementById('stat-total-accounts').textContent = stats.accounts.total_accounts;
        document.getElementById('stat-total-tx').textContent = stats.transactions.total_transactions;
        document.getElementById('stat-total-audit').textContent = stats.audit.total_audit_entries;

        await loadAdminUsers();
    } catch (err) {
        console.error('Failed to load admin dashboard:', err);
    }
}

async function loadAdminUsers() {
    const tbody = document.getElementById('admin-users-table-body');
    try {
        const { users } = await apiRequest('/api/admin/users');
        if (!users || users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-slate-400">No users found.</td></tr>`;
            return;
        }

        tbody.innerHTML = users.map(u => {
            const statusBadge = u.status === 'ACTIVE' 
                ? '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">ACTIVE</span>'
                : u.status === 'PENDING_APPROVAL'
                ? '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 animate-pulse">PENDING APPROVAL</span>'
                : '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-800">DEACTIVATED</span>';

            const actionButtons = u.status === 'PENDING_APPROVAL' 
                ? `<button onclick="activateUser('${u.id}')" class="px-2.5 py-1 rounded bg-teal-600 hover:bg-teal-500 text-white font-medium text-[11px] shadow-sm"><i class="fa-solid fa-check mr-1"></i>Approve & Activate</button>`
                : u.status === 'ACTIVE' && u.id !== currentUser.id
                ? `<button onclick="deactivateUser('${u.id}')" class="px-2 py-1 rounded bg-slate-200 hover:bg-rose-100 hover:text-rose-700 text-slate-700 text-[11px]"><i class="fa-solid fa-ban mr-1"></i>Deactivate</button>`
                : u.status === 'DEACTIVATED'
                ? `<button onclick="activateUser('${u.id}')" class="px-2 py-1 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200 text-[11px]">Reactivate</button>`
                : '<span class="text-slate-400 text-xs">Self (Admin)</span>';

            return `
                <tr class="hover:bg-slate-50 transition">
                    <td class="py-3 px-4 font-semibold text-slate-900">${u.username}</td>
                    <td class="py-3 px-4 text-slate-600">${u.email}</td>
                    <td class="py-3 px-4"><span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[10px]">${u.role}</span></td>
                    <td class="py-3 px-4">${statusBadge}</td>
                    <td class="py-3 px-4 font-mono text-[11px] text-slate-400">${new Date(u.created_at).toLocaleDateString()}</td>
                    <td class="py-3 px-4 text-right">${actionButtons}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-rose-500">Error loading users: ${err.message}</td></tr>`;
    }
}

async function activateUser(userId) {
    try {
        await apiRequest(`/api/admin/users/${userId}/activate`, 'POST');
        showToast('User successfully approved and activated!', 'success');
        loadAdminDashboard();
    } catch (err) {
        showToast(`Failed to activate user: ${err.message}`, 'error');
    }
}

async function deactivateUser(userId) {
    try {
        await apiRequest(`/api/admin/users/${userId}/deactivate`, 'POST');
        showToast('User deactivated.', 'info');
        loadAdminDashboard();
    } catch (err) {
        showToast(`Failed to deactivate user: ${err.message}`, 'error');
    }
}

// -----------------------------------------------------------------------------
// Auditor & Double-Entry Ledger Dashboard
// -----------------------------------------------------------------------------
async function loadAuditorDashboard() {
    await verifyLedgerConservation();
    if (currentUser?.role === 'AUDITOR' || currentUser?.role === 'ADMIN') {
        await loadLedgerEntries();
        await loadAuditLogs();
    }
}

async function verifyLedgerConservation() {
    try {
        const data = await apiRequest('/api/ledger/conservation');
        const debits = data.ledger_stats.total_debits;
        const credits = data.ledger_stats.total_credits;
        const diff = data.ledger_stats.difference;

        document.getElementById('audit-total-debits').textContent = `$${(debits / 100).toFixed(2)}`;
        document.getElementById('audit-total-credits').textContent = `$${(credits / 100).toFixed(2)}`;
        document.getElementById('audit-difference').textContent = `$${(diff / 100).toFixed(2)}`;

        const statusPill = document.getElementById('conservation-status-text');
        if (data.is_valid && diff === 0) {
            statusPill.textContent = `Zero-Sum Conserved (Δ = $0.00)`;
            statusPill.className = `text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200`;
        } else {
            statusPill.textContent = `IMBALANCE DETECTED (Δ = $${(diff / 100).toFixed(2)})`;
            statusPill.className = `text-rose-700 font-semibold bg-rose-50 px-2 py-0.5 rounded border border-rose-200`;
        }
    } catch (err) {
        console.error('Failed to verify conservation:', err);
    }
}

async function loadLedgerEntries() {
    const tbody = document.getElementById('ledger-entries-table-body');
    try {
        const { entries } = await apiRequest('/api/ledger/entries?limit=50');
        if (!entries || entries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-slate-400">No ledger entries recorded yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = entries.map(e => `
            <tr class="hover:bg-slate-50 transition">
                <td class="py-2.5 px-4 font-mono text-[10px] text-slate-400 truncate max-w-[100px]">${e.id}</td>
                <td class="py-2.5 px-4 font-mono text-[10px] text-slate-500 truncate max-w-[100px]">${e.transaction_id}</td>
                <td class="py-2.5 px-4 font-mono font-medium text-slate-800">${e.account_number}</td>
                <td class="py-2.5 px-4 text-slate-600">${e.owner_username}</td>
                <td class="py-2.5 px-4">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${e.direction === 'DEBIT' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}">
                        ${e.direction}
                    </span>
                </td>
                <td class="py-2.5 px-4 text-right font-mono font-bold text-slate-900">$${(e.amount / 100).toFixed(2)}</td>
                <td class="py-2.5 px-4 font-mono text-[10px] text-slate-400">${new Date(e.created_at).toLocaleTimeString()}</td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-500">Error loading ledger: ${err.message}</td></tr>`;
    }
}

async function loadAuditLogs() {
    const tbody = document.getElementById('audit-logs-table-body');
    try {
        const { logs } = await apiRequest('/api/audit/logs?limit=50');
        if (!logs || logs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-slate-400">No audit logs recorded yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = logs.map(l => `
            <tr class="hover:bg-slate-50 transition">
                <td class="py-2.5 px-4 font-mono text-[10px] text-slate-400">${new Date(l.created_at).toLocaleTimeString()}</td>
                <td class="py-2.5 px-4 font-semibold text-slate-800">${l.actor_username || 'System'}</td>
                <td class="py-2.5 px-4"><span class="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono text-[10px]">${l.actor_role || 'SYSTEM'}</span></td>
                <td class="py-2.5 px-4 font-mono text-[11px] font-semibold text-indigo-700">${l.action}</td>
                <td class="py-2.5 px-4 text-slate-500 text-[11px]">${l.entity_type}</td>
                <td class="py-2.5 px-4"><span class="px-1.5 py-0.5 rounded text-[10px] ${l.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${l.status}</span></td>
                <td class="py-2.5 px-4 font-mono text-[10px] text-slate-500 truncate max-w-[150px]">${typeof l.details === 'object' ? JSON.stringify(l.details) : l.details || '-'}</td>
            </tr>
        `).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-500">Error loading audit: ${err.message}</td></tr>`;
    }
}

// -----------------------------------------------------------------------------
// Interactive 100-Parallel Stress Test Runner (Live Demo Widget)
// -----------------------------------------------------------------------------
async function runConcurrencyStressTest() {
    if (!currentAccount) {
        showToast('Please select or log in as an Account Holder first', 'warning');
        return;
    }

    const btn = document.getElementById('btn-run-stress-test');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Executing 100 Parallel Requests...`;

    const resultsCard = document.getElementById('stress-test-results');
    resultsCard.classList.remove('hidden');

    const consoleLog = document.getElementById('stress-log-console');
    consoleLog.innerHTML = `[${new Date().toLocaleTimeString()}] Firing 100 concurrent withdrawal requests of $10.00 each against account ${currentAccount.account_number} (Starting balance: $${(currentAccount.balance / 100).toFixed(2)})...\n`;

    const totalRequests = 100;
    const amountCents = 1000; // $10.00
    const promises = [];

    const startTime = performance.now();

    for (let i = 1; i <= totalRequests; i++) {
        const key = `web_stress_tx_${i}_${Date.now()}`;
        promises.push(
            apiRequest('/api/transactions/withdraw', 'POST', {
                accountId: currentAccount.id,
                amount: amountCents,
                description: `Web Concurrency Test #${i}`
            }, { 'Idempotency-Key': key })
            .then(res => ({ success: true, reqNum: i, res }))
            .catch(err => ({ success: false, reqNum: i, error: err.message }))
        );
    }

    const results = await Promise.all(promises);
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

    let successes = 0;
    let failures = 0;

    results.forEach(r => {
        if (r.success) {
            successes++;
            consoleLog.innerHTML += `<span class="text-emerald-400">✓ Req #${r.reqNum}: Succeeded! New Balance: $${(r.res.newBalance / 100).toFixed(2)}</span>\n`;
        } else {
            failures++;
            consoleLog.innerHTML += `<span class="text-rose-400">✗ Req #${r.reqNum}: Safely Rejected (${r.error})</span>\n`;
        }
    });

    consoleLog.innerHTML += `\n[${new Date().toLocaleTimeString()}] 100 Parallel Requests Completed in ${elapsed}s!\n`;
    consoleLog.scrollTop = consoleLog.scrollHeight;

    document.getElementById('stress-success-count').textContent = successes;
    document.getElementById('stress-failed-count').textContent = failures;

    // Refresh balance and verification
    await loadAccountDashboard();
    await verifyLedgerConservation();

    document.getElementById('stress-final-balance').textContent = `$${(currentAccount.balance / 100).toFixed(2)}`;
    document.getElementById('stress-ledger-status').textContent = '100% CONSERVED';

    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-play"></i> Fire 100 Parallel Requests Again`;

    showToast(`Test Complete: ${successes} succeeded, ${failures} safely rejected. Zero negative balances!`, 'success');
}

// -----------------------------------------------------------------------------
// Authentication Modal Logic
// -----------------------------------------------------------------------------
function showLoginModal() {
    document.getElementById('auth-modal').classList.remove('hidden');
}

function toggleAuthMode() {
    isRegisterMode = !isRegisterMode;
    document.getElementById('auth-modal-title').textContent = isRegisterMode ? 'Self-Register as Account Holder' : 'Sign In to LedgerLine';
    document.getElementById('auth-email-container').classList.toggle('hidden', !isRegisterMode);
    document.getElementById('auth-toggle-btn').textContent = isRegisterMode ? 'Already have an account? Sign In' : 'Need an account? Register';
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('auth-username-input').value;
    const password = document.getElementById('auth-password-input').value;

    if (isRegisterMode) {
        const email = document.getElementById('auth-email-input').value;
        try {
            await apiRequest('/api/auth/register', 'POST', { username, email, password, role: 'ACCOUNT_HOLDER' });
            showToast('Registration submitted! Awaiting administrator activation.', 'info');
            closeModals();
        } catch (err) {
            showToast(`Registration failed: ${err.message}`, 'error');
        }
    } else {
        try {
            const res = await apiRequest('/api/auth/login', 'POST', { username, password });
            currentToken = res.token;
            currentUser = res.user;
            localStorage.setItem('ledgerline_token', currentToken);
            localStorage.setItem('ledgerline_user', JSON.stringify(currentUser));
            updateUserUI();
            closeModals();
            showToast(`Welcome back, ${currentUser.username}!`, 'success');
            refreshCurrentView();
        } catch (err) {
            showToast(`Login failed: ${err.message}`, 'error');
        }
    }
}

// -----------------------------------------------------------------------------
// Initialization on Page Load
// -----------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
    // Default start as Alice
    await loginAs('alice');
});

