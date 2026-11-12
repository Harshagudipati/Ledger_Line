/**
 * LedgerLine / BalanceVault Frontend Application
 * Connects to the zero-dependency Node.js backend REST API.
 */

const API_BASE = '/api';

const DEMO_PASSWORDS = {
    alice: 'AlicePassword123!',
    bob: 'BobPassword123!',
    charlie: 'CharliePassword123!',
    admin: 'AdminPassword123!',
    auditor: 'AuditorPassword123!'
};

const state = {
    token: localStorage.getItem('ledgerline_token') || null,
    user: null,
    accounts: [],
    activeAccountId: null,
    lastTransaction: null,
    authMode: 'login', // 'login' | 'register'
    currentTab: 'holder-tab',
    lastStatementTransactions: []
};

// ============================================================================
// UTILITY HELPERS
// ============================================================================

function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatMoney(cents) {
    const num = Number(cents || 0) / 100;
    return '$' + num.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function generateIdempotencyKey(prefix = 'ui') {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const palette = {
        success: 'bg-emerald-900 border-emerald-500 text-emerald-50',
        error: 'bg-rose-900 border-rose-500 text-rose-50',
        warning: 'bg-amber-900 border-amber-500 text-amber-50',
        info: 'bg-slate-900 border-teal-500 text-slate-50'
    };

    const icons = {
        success: 'fa-circle-check text-emerald-400',
        error: 'fa-circle-exclamation text-rose-400',
        warning: 'fa-triangle-exclamation text-amber-400',
        info: 'fa-circle-info text-teal-400'
    };

    const toast = document.createElement('div');
    toast.className = `max-w-sm px-4 py-3 rounded-xl border shadow-xl text-xs flex items-start gap-2.5 transition-all duration-300 ${palette[type] || palette.info}`;
    toast.innerHTML = `
        <i class="fa-solid ${icons[type] || icons.info} mt-0.5 text-sm"></i>
        <div class="flex-1 leading-relaxed">${escapeHtml(message)}</div>
        <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-white ml-2">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;

    container.appendChild(toast);
    setTimeout(() => {
        if (toast.parentElement) {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }
    }, 5500);
}

async function apiRequest(path, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
    };

    if (state.token && !options.skipAuth) {
        headers['Authorization'] = `Bearer ${state.token}`;
    }

    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers
    });

    const text = await res.text();
    let data = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { message: text };
    }

    if (!res.ok) {
        const err = new Error(data.message || `Request failed with status ${res.status}`);
        err.status = res.status;
        err.code = data.error || 'REQUEST_ERROR';
        err.data = data;
        throw err;
    }

    return data;
}

// ============================================================================
// INITIALIZATION & HEALTH CHECK
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
    await checkSystemHealth();

    if (state.token) {
        try {
            const me = await apiRequest('/auth/me');
            state.user = me.user;
            onAuthSuccess();
            return;
        } catch {
            clearSessionState();
        }
    }

    // Default to Alice on initial page load for instant challenge demo UX
    await loginAs('alice', { silent: true });
});

async function checkSystemHealth() {
    const healthEl = document.getElementById('api-health-text');
    try {
        const data = await apiRequest('/health', { skipAuth: true });
        if (healthEl) {
            healthEl.textContent = data.status || 'UP';
            healthEl.className = 'text-emerald-700';
        }
    } catch {
        if (healthEl) {
            healthEl.textContent = 'DOWN';
            healthEl.className = 'text-rose-700';
        }
    }
}

// ============================================================================
// AUTHENTICATION & PERSONA SWITCHING
// ============================================================================

function clearSessionState() {
    state.token = null;
    state.user = null;
    state.accounts = [];
    state.activeAccountId = null;
    state.lastTransaction = null;
    state.lastStatementTransactions = [];
    localStorage.removeItem('ledgerline_token');
}

async function loginAs(persona, opts = {}) {
    const username = persona.toLowerCase();
    const password = DEMO_PASSWORDS[username];
    if (!password) {
        showToast(`Unknown demo persona: ${persona}`, 'error');
        return false;
    }

    try {
        const data = await apiRequest('/auth/login', {
            method: 'POST',
            skipAuth: true,
            body: JSON.stringify({ username, password })
        });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('ledgerline_token', data.token);
        onAuthSuccess();

        if (!opts.silent) {
            showToast(`Signed in as ${data.user.username} (${data.user.role})`, 'success');
        }
        return true;
    } catch (err) {
        if (err.code === 'USER_NOT_ACTIVE' || err.status === 403) {
            showToast(
                `${username} is currently PENDING_APPROVAL. Switch to Admin to approve them first (FR-6 / FR-7)!`,
                'warning'
            );
        } else {
            showToast(`Login failed for ${username}: ${err.message}`, 'error');
        }
        return false;
    }
}

function logout() {
    clearSessionState();
    updateHeaderUI();
    renderSignedOutUI();
    showToast('Signed out of active session.', 'info');
}

function onAuthSuccess() {
    state.lastTransaction = null;
    const replayCard = document.getElementById('idempotency-demo-card');
    if (replayCard) replayCard.classList.add('hidden');

    updateHeaderUI();

    const unauthBanner = document.getElementById('holder-unauth-warning');
    if (unauthBanner) unauthBanner.classList.add('hidden');

    // Auto-select tab appropriate for the logged-in role
    if (state.user.role === 'ADMIN') {
        switchTab('admin-tab');
    } else if (state.user.role === 'AUDITOR') {
        switchTab('auditor-tab');
    } else {
        switchTab('holder-tab');
    }

    refreshActiveViews();
}

function updateHeaderUI() {
    const usernameEl = document.getElementById('current-username');
    const roleEl = document.getElementById('current-role-badge');

    document.querySelectorAll('.persona-btn').forEach(btn => {
        btn.classList.remove('ring-2', 'ring-teal-400', 'bg-slate-700');
    });

    if (!state.user) {
        if (usernameEl) usernameEl.textContent = 'Signed Out';
        if (roleEl) {
            roleEl.textContent = 'GUEST';
            roleEl.className = 'px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide bg-slate-200 text-slate-700 border border-slate-300';
        }
        return;
    }

    if (usernameEl) usernameEl.textContent = state.user.username;

    const roleStyles = {
        ADMIN: 'bg-amber-100 text-amber-800 border-amber-200',
        AUDITOR: 'bg-teal-100 text-teal-800 border-teal-200',
        ACCOUNT_HOLDER: 'bg-blue-100 text-blue-800 border-blue-200'
    };

    if (roleEl) {
        roleEl.textContent = state.user.role;
        roleEl.className = `px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide border ${roleStyles[state.user.role] || roleStyles.ACCOUNT_HOLDER}`;
    }

    const activeBtn = document.getElementById(`btn-${state.user.username.toLowerCase()}`);
    if (activeBtn) {
        activeBtn.classList.add('ring-2', 'ring-teal-400', 'bg-slate-700');
    }
}

function renderSignedOutUI() {
    const unauthBanner = document.getElementById('holder-unauth-warning');
    if (unauthBanner) unauthBanner.classList.remove('hidden');

    const select = document.getElementById('user-accounts-select');
    if (select) select.innerHTML = '<option value="">Not signed in</option>';

    document.getElementById('account-type-badge').textContent = 'SIGNED OUT';
    document.getElementById('account-number-display').textContent = '---';
    document.getElementById('account-status-badge').textContent = '---';
    document.getElementById('account-balance-display').textContent = '$0.00';
    document.getElementById('stress-current-balance').textContent = '$0.00';
    document.getElementById('statement-table-body').innerHTML =
        '<tr><td colspan="6" class="py-8 text-center text-slate-400">Sign in to view account statement.</td></tr>';
}

// ============================================================================
// NAVIGATION TABS & ROLE BANNERS
// ============================================================================

function switchTab(tabId) {
    state.currentTab = tabId;

    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById(tabId);
    if (target) target.classList.remove('hidden');

    const tabButtonMap = {
        'holder-tab': 'tab-btn-holder',
        'admin-tab': 'tab-btn-admin',
        'auditor-tab': 'tab-btn-auditor',
        'concurrency-tab': 'tab-btn-concurrency'
    };

    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('border-teal-600', 'text-teal-600');
        btn.classList.add('border-transparent', 'text-slate-500');
    });

    const activeTabBtn = document.getElementById(tabButtonMap[tabId]);
    if (activeTabBtn) {
        activeTabBtn.classList.remove('border-transparent', 'text-slate-500');
        activeTabBtn.classList.add('border-teal-600', 'text-teal-600');
    }

    refreshActiveViews();
}

async function refreshActiveViews() {
    await verifyLedgerConservation();

    if (!state.user) {
        renderSignedOutUI();
        return;
    }

    const adminWarning = document.getElementById('admin-role-warning');
    const auditorWarning = document.getElementById('auditor-role-warning');

    if (state.currentTab === 'holder-tab' || state.currentTab === 'concurrency-tab') {
        await loadUserAccounts();
    } else if (state.currentTab === 'admin-tab') {
        if (state.user.role !== 'ADMIN') {
            if (adminWarning) adminWarning.classList.remove('hidden');
        } else {
            if (adminWarning) adminWarning.classList.add('hidden');
            await Promise.all([loadAdminStats(), loadAdminUsers(), loadAdminAccounts()]);
        }
    } else if (state.currentTab === 'auditor-tab') {
        if (state.user.role !== 'AUDITOR' && state.user.role !== 'ADMIN') {
            if (auditorWarning) auditorWarning.classList.remove('hidden');
        } else {
            if (auditorWarning) auditorWarning.classList.add('hidden');
            await Promise.all([loadLedgerEntries(), loadAuditLogs()]);
        }
    }
}

// ============================================================================
// ACCOUNT HOLDER OPERATIONS (FR-8, FR-9, FR-10, FR-11, FR-12, FR-14)
// ============================================================================

async function loadUserAccounts() {
    if (!state.user) return;
    try {
        const data = await apiRequest('/accounts');
        state.accounts = data.accounts || [];

        const select = document.getElementById('user-accounts-select');
        if (!select) return;

        if (state.accounts.length === 0) {
            state.activeAccountId = null;
            select.innerHTML = '<option value="">No accounts yet — click Open Secondary Account</option>';
            document.getElementById('account-type-badge').textContent = 'NO ACCOUNT';
            document.getElementById('account-number-display').textContent = 'Create an account to begin';
            document.getElementById('account-status-badge').textContent = '---';
            document.getElementById('account-balance-display').textContent = '$0.00';
            document.getElementById('stress-current-balance').textContent = '$0.00';
            document.getElementById('statement-table-body').innerHTML =
                '<tr><td colspan="6" class="py-8 text-center text-slate-400">No accounts found for this user.</td></tr>';
            return;
        }

        // Preserve active account if still in list
        if (!state.accounts.some(a => a.id === state.activeAccountId)) {
            state.activeAccountId = state.accounts[0].id;
        }

        select.innerHTML = state.accounts
            .map(acc => {
                const selected = acc.id === state.activeAccountId ? 'selected' : '';
                return `<option value="${escapeHtml(acc.id)}" ${selected}>${escapeHtml(acc.account_number)} (${escapeHtml(acc.account_type)}) - ${formatMoney(acc.balance)} [${escapeHtml(acc.status)}]</option>`;
            })
            .join('');

        await switchActiveAccount(state.activeAccountId);
    } catch (err) {
        showToast(`Failed to load accounts: ${err.message}`, 'error');
    }
}

async function switchActiveAccount(accountId) {
    if (!accountId) return;
    state.activeAccountId = accountId;

    const acc = state.accounts.find(a => a.id === accountId);
    if (!acc) return;

    document.getElementById('account-type-badge').textContent = `${acc.account_type} ACCOUNT`;
    document.getElementById('account-number-display').textContent = acc.account_number;
    document.getElementById('account-balance-display').textContent = formatMoney(acc.balance);
    document.getElementById('stress-current-balance').textContent = formatMoney(acc.balance);

    const statusBadge = document.getElementById('account-status-badge');
    if (statusBadge) {
        statusBadge.textContent = acc.status;
        if (acc.status === 'ACTIVE') {
            statusBadge.className = 'text-[11px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-200';
        } else if (acc.status === 'FROZEN') {
            statusBadge.className = 'text-[11px] font-bold uppercase px-2 py-0.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-200';
        } else {
            statusBadge.className = 'text-[11px] font-bold uppercase px-2 py-0.5 rounded bg-rose-500/20 border border-rose-400/40 text-rose-200';
        }
    }

    await loadAccountStatement();
}

async function loadAccountStatement() {
    if (!state.activeAccountId) return;

    const tbody = document.getElementById('statement-table-body');
    const consistencyBadge = document.getElementById('statement-consistency-badge');
    try {
        const data = await apiRequest(`/accounts/${encodeURIComponent(state.activeAccountId)}/statement`);
        const entries = data.statement_entries || [];
        state.lastStatementTransactions = entries;

        if (consistencyBadge) {
            if (data.is_balance_consistent) {
                consistencyBadge.innerHTML = '<i class="fa-solid fa-check-double"></i> Reconciled';
                consistencyBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1';
            } else {
                consistencyBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Mismatch';
                consistencyBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1';
            }
        }

        if (entries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">No ledger entries recorded for this account yet.</td></tr>';
            return;
        }

        // Show newest entries first while preserving exact runningBalance computed chronologically
        const reversed = [...entries].reverse();
        tbody.innerHTML = reversed
            .map(row => {
                const isCredit = row.direction === 'CREDIT';
                const badgeClass = isCredit
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                    : 'bg-rose-100 text-rose-800 border-rose-200';
                const sign = isCredit ? '+' : '-';

                return `
                    <tr class="hover:bg-slate-50 transition">
                        <td class="py-3 px-4 text-slate-500 whitespace-nowrap">${escapeHtml(new Date(row.created_at).toLocaleString())}</td>
                        <td class="py-3 px-4 font-medium text-slate-800">${escapeHtml(row.transaction_type)}</td>
                        <td class="py-3 px-4 text-slate-600">
                            <div>${escapeHtml(row.description || '---')}</div>
                            <div class="text-[10px] font-mono text-slate-400">${escapeHtml(row.idempotency_key || '')}</div>
                        </td>
                        <td class="py-3 px-4">
                            <span class="px-2 py-0.5 rounded text-[11px] font-bold border ${badgeClass}">
                                ${escapeHtml(row.direction)}
                            </span>
                        </td>
                        <td class="py-3 px-4 text-right font-mono font-semibold ${isCredit ? 'text-emerald-600' : 'text-rose-600'}">
                            ${sign}${formatMoney(row.amount)}
                        </td>
                        <td class="py-3 px-4 text-right font-mono font-bold text-slate-900">
                            ${formatMoney(row.running_balance)}
                        </td>
                    </tr>
                `;
            })
            .join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-rose-600">${escapeHtml(err.message)}</td></tr>`;
    }
}

function exportStatementCSV() {
    const entries = state.lastStatementTransactions || [];
    if (entries.length === 0) {
        showToast('No statement transactions to export yet.', 'warning');
        return;
    }

    const activeAcc = state.accounts.find(a => a.id === state.activeAccountId);
    const header = ['Timestamp', 'Type', 'Description', 'Direction', 'Amount USD', 'Running Balance USD', 'Idempotency Key'];
    const rows = entries.map(row => [
        row.created_at,
        row.transaction_type,
        `"${String(row.description || '').replace(/"/g, '""')}"`,
        row.direction,
        (Number(row.amount) / 100).toFixed(2),
        (Number(row.running_balance) / 100).toFixed(2),
        row.idempotency_key || ''
    ]);

    const csvContent = [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `statement-${activeAcc ? activeAcc.account_number : 'account'}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showToast('Account statement CSV downloaded.', 'success');
}

// ============================================================================
// MODALS & MONEY MOVEMENT (DEPOSIT / WITHDRAW / TRANSFER / CREATE ACCOUNT)
// ============================================================================

function closeModals() {
    document.querySelectorAll('[id$="-modal"]').forEach(modal => {
        modal.classList.add('hidden');
    });
}

function openNewAccountModal() {
    if (!state.user) {
        showToast('Sign in first to open an account.', 'warning');
        return;
    }
    document.getElementById('new-account-modal').classList.remove('hidden');
}

async function handleCreateAccount(event) {
    event.preventDefault();
    const accountType = document.getElementById('new-account-type-select').value;
    try {
        const data = await apiRequest('/accounts', {
            method: 'POST',
            body: JSON.stringify({ accountType, currency: 'USD' })
        });
        closeModals();
        showToast(`Opened new ${accountType} account ${data.account.account_number}`, 'success');
        state.activeAccountId = data.account.id;
        await loadUserAccounts();
    } catch (err) {
        showToast(`Could not open account: ${err.message}`, 'error');
    }
}

function openDepositModal() {
    if (!state.activeAccountId) {
        showToast('Select or create an active account first.', 'warning');
        return;
    }
    document.getElementById('deposit-amount-input').value = '';
    document.getElementById('deposit-modal').classList.remove('hidden');
}

function openWithdrawModal() {
    if (!state.activeAccountId) {
        showToast('Select or create an active account first.', 'warning');
        return;
    }
    document.getElementById('withdraw-amount-input').value = '';
    document.getElementById('withdraw-modal').classList.remove('hidden');
}

async function openTransferModal() {
    if (!state.activeAccountId) {
        showToast('Select or create an active source account first.', 'warning');
        return;
    }
    document.getElementById('transfer-amount-input').value = '';
    document.getElementById('transfer-account-number-input').value = '';

    const select = document.getElementById('transfer-destination-select');
    select.innerHTML = '<option value="">Loading active recipient accounts...</option>';
    document.getElementById('transfer-modal').classList.remove('hidden');

    try {
        const data = await apiRequest(
            `/accounts/recipients?excludeAccountId=${encodeURIComponent(state.activeAccountId)}`
        );
        const recipients = data.recipients || [];
        const options = ['<option value="">-- Select a recipient account (or type account # below) --</option>'];

        for (const r of recipients) {
            const isOwn = state.user && r.owner_username === state.user.username;
            const ownerTag = isOwn ? `${r.owner_username} (Your Own)` : r.owner_username;
            options.push(
                `<option value="${escapeHtml(r.id)}">${escapeHtml(ownerTag)} — ${escapeHtml(r.account_number)} (${escapeHtml(r.account_type)})</option>`
            );
        }
        select.innerHTML = options.join('');
    } catch (err) {
        select.innerHTML = '<option value="">Enter recipient account number below</option>';
        showToast(`Recipient lookup warning: ${err.message}`, 'warning');
    }
}

function recordLastIdempotentTransaction(endpoint, payload, idempotencyKey, label) {
    state.lastTransaction = { endpoint, payload, idempotencyKey, label };
    const card = document.getElementById('idempotency-demo-card');
    const keyEl = document.getElementById('last-idempotency-key');
    const descEl = document.getElementById('last-idempotency-desc');
    if (card && keyEl && descEl) {
        keyEl.textContent = idempotencyKey;
        descEl.textContent = label;
        card.classList.remove('hidden');
    }
}

async function handleDeposit(event) {
    event.preventDefault();
    const dollars = Number(document.getElementById('deposit-amount-input').value);
    const description = document.getElementById('deposit-desc-input').value.trim();
    const amountCents = Math.round(dollars * 100);
    const idempotencyKey = generateIdempotencyKey('dep');

    const payload = {
        accountId: state.activeAccountId,
        amount: amountCents,
        description
    };

    try {
        await apiRequest('/transactions/deposit', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(payload)
        });
        closeModals();
        recordLastIdempotentTransaction('/transactions/deposit', payload, idempotencyKey, `Deposit ${formatMoney(amountCents)}`);
        showToast(`Deposited ${formatMoney(amountCents)} cleanly!`, 'success');
        await Promise.all([loadUserAccounts(), verifyLedgerConservation()]);
    } catch (err) {
        showToast(`Deposit failed: ${err.message}`, 'error');
    }
}

async function handleWithdraw(event) {
    event.preventDefault();
    const dollars = Number(document.getElementById('withdraw-amount-input').value);
    const description = document.getElementById('withdraw-desc-input').value.trim();
    const amountCents = Math.round(dollars * 100);
    const idempotencyKey = generateIdempotencyKey('wdl');

    const payload = {
        accountId: state.activeAccountId,
        amount: amountCents,
        description
    };

    try {
        await apiRequest('/transactions/withdraw', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(payload)
        });
        closeModals();
        recordLastIdempotentTransaction('/transactions/withdraw', payload, idempotencyKey, `Withdrawal ${formatMoney(amountCents)}`);
        showToast(`Withdrew ${formatMoney(amountCents)} cleanly!`, 'success');
        await Promise.all([loadUserAccounts(), verifyLedgerConservation()]);
    } catch (err) {
        showToast(`Withdrawal failed: ${err.message}`, 'error');
    }
}

async function handleTransfer(event) {
    event.preventDefault();
    const destinationAccountId = document.getElementById('transfer-destination-select').value.trim();
    const destinationAccountNumber = document.getElementById('transfer-account-number-input').value.trim();
    const dollars = Number(document.getElementById('transfer-amount-input').value);
    const description = document.getElementById('transfer-desc-input').value.trim();
    const amountCents = Math.round(dollars * 100);

    if (!destinationAccountId && !destinationAccountNumber) {
        showToast('Select a destination account or enter a recipient account number.', 'warning');
        return;
    }

    const idempotencyKey = generateIdempotencyKey('xfer');
    const payload = {
        sourceAccountId: state.activeAccountId,
        amount: amountCents,
        description
    };
    if (destinationAccountNumber) {
        payload.destinationAccountNumber = destinationAccountNumber;
    } else {
        payload.destinationAccountId = destinationAccountId;
    }

    try {
        await apiRequest('/transactions/transfer', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(payload)
        });
        closeModals();
        recordLastIdempotentTransaction(
            '/transactions/transfer',
            payload,
            idempotencyKey,
            `Transfer ${formatMoney(amountCents)}`
        );
        showToast(`Transferred ${formatMoney(amountCents)} atomically!`, 'success');
        await Promise.all([loadUserAccounts(), verifyLedgerConservation()]);
    } catch (err) {
        showToast(`Transfer failed: ${err.message}`, 'error');
    }
}

async function replayLastTransaction() {
    if (!state.lastTransaction) {
        showToast('Execute a deposit, withdrawal, or transfer first to test idempotency replay.', 'info');
        return;
    }

    const { endpoint, payload, idempotencyKey, label } = state.lastTransaction;
    try {
        const res = await apiRequest(endpoint, {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(payload)
        });

        if (res.isCached) {
            showToast(
                `IDEMPOTENT REPLAY VERIFIED (FR-15): Re-sending key "${idempotencyKey}" for "${label}" returned the cached response without executing twice!`,
                'success'
            );
        } else {
            showToast('Request completed without replay flag.', 'info');
        }
        await Promise.all([loadUserAccounts(), verifyLedgerConservation()]);
    } catch (err) {
        showToast(`Idempotency replay error: ${err.message}`, 'error');
    }
}

// ============================================================================
// CUSTOM LOGIN / SELF-REGISTRATION MODAL
// ============================================================================

function showLoginModal() {
    state.authMode = 'login';
    updateAuthModalUI();
    document.getElementById('auth-username-input').value = '';
    document.getElementById('auth-email-input').value = '';
    document.getElementById('auth-password-input').value = '';
    document.getElementById('auth-modal').classList.remove('hidden');
}

function toggleAuthMode() {
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    updateAuthModalUI();
}

function updateAuthModalUI() {
    const isReg = state.authMode === 'register';
    document.getElementById('auth-modal-title').textContent = isReg
        ? 'Register Account Holder'
        : 'Sign In to LedgerLine';
    document.getElementById('auth-email-container').classList.toggle('hidden', !isReg);
    document.getElementById('auth-email-input').required = isReg;
    document.getElementById('auth-toggle-btn').textContent = isReg
        ? 'Already have an account? Sign In'
        : 'Need an account? Register';
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    const username = document.getElementById('auth-username-input').value.trim();
    const email = document.getElementById('auth-email-input').value.trim();
    const password = document.getElementById('auth-password-input').value;

    try {
        if (state.authMode === 'register') {
            await apiRequest('/auth/register', {
                method: 'POST',
                skipAuth: true,
                body: JSON.stringify({ username, email, password })
            });
            closeModals();
            showToast(
                `Registered "${username}" with PENDING_APPROVAL status. Sign in as Admin to approve them before login (FR-6 / FR-7).`,
                'success'
            );
        } else {
            const data = await apiRequest('/auth/login', {
                method: 'POST',
                skipAuth: true,
                body: JSON.stringify({ username, password })
            });
            state.token = data.token;
            state.user = data.user;
            localStorage.setItem('ledgerline_token', data.token);
            closeModals();
            onAuthSuccess();
            showToast(`Welcome back, ${data.user.username}!`, 'success');
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ============================================================================
// ADMIN TAB: STATS, USER MANAGEMENT, ACCOUNT FREEZE/CLOSE, DEMO RESET
// ============================================================================

async function loadAdminStats() {
    try {
        const data = await apiRequest('/admin/stats');
        const stats = data.stats || data;
        document.getElementById('stat-total-users').textContent = stats.users?.total_users ?? 0;
        document.getElementById('stat-pending-users').textContent = stats.users?.pending_users ?? 0;
        document.getElementById('stat-total-accounts').textContent = stats.accounts?.total_accounts ?? 0;
        document.getElementById('stat-total-balances').textContent = formatMoney(stats.accounts?.total_balances || 0);
        document.getElementById('stat-total-tx').textContent = stats.transactions?.total_transactions ?? 0;
        document.getElementById('stat-total-audit').textContent = stats.audit?.total_audit_entries ?? 0;
    } catch (err) {
        showToast(`Failed to load admin stats: ${err.message}`, 'error');
    }
}

async function loadAdminUsers() {
    const tbody = document.getElementById('admin-users-table-body');
    const statusFilter = document.getElementById('admin-user-filter').value;
    const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';

    try {
        const data = await apiRequest(`/admin/users${query}`);
        const users = data.users || [];

        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">No users matching filter.</td></tr>';
            return;
        }

        const statusBadges = {
            ACTIVE: 'bg-emerald-100 text-emerald-800 border-emerald-200',
            PENDING_APPROVAL: 'bg-amber-100 text-amber-800 border-amber-200',
            DEACTIVATED: 'bg-rose-100 text-rose-800 border-rose-200'
        };

        tbody.innerHTML = users
            .map(u => {
                const isSelf = state.user && u.id === state.user.id;
                let actionBtns = '';
                if (u.status === 'PENDING_APPROVAL' || u.status === 'DEACTIVATED') {
                    actionBtns += `<button onclick="activateUser('${escapeHtml(u.id)}')" class="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium mr-1">Approve / Activate</button>`;
                }
                if (u.status === 'ACTIVE' && !isSelf) {
                    actionBtns += `<button onclick="deactivateUser('${escapeHtml(u.id)}')" class="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-medium">Deactivate</button>`;
                }
                if (!actionBtns) {
                    actionBtns = '<span class="text-[11px] text-slate-400">Current Operator</span>';
                }

                return `
                    <tr class="hover:bg-slate-50">
                        <td class="py-3 px-4 font-semibold text-slate-800">${escapeHtml(u.username)}</td>
                        <td class="py-3 px-4 text-slate-600">${escapeHtml(u.email)}</td>
                        <td class="py-3 px-4 font-mono text-[11px]">${escapeHtml(u.role)}</td>
                        <td class="py-3 px-4">
                            <span class="px-2 py-0.5 rounded text-[11px] font-bold border ${statusBadges[u.status] || 'bg-slate-100 text-slate-700'}">
                                ${escapeHtml(u.status)}
                            </span>
                        </td>
                        <td class="py-3 px-4 text-slate-500">${escapeHtml(new Date(u.created_at).toLocaleDateString())}</td>
                        <td class="py-3 px-4 text-right whitespace-nowrap">${actionBtns}</td>
                    </tr>
                `;
            })
            .join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-rose-600">${escapeHtml(err.message)}</td></tr>`;
    }
}

async function activateUser(userId) {
    try {
        const res = await apiRequest(`/admin/users/${encodeURIComponent(userId)}/activate`, {
            method: 'POST'
        });
        showToast(res.message || 'User approved and activated.', 'success');
        await Promise.all([loadAdminUsers(), loadAdminStats()]);
    } catch (err) {
        showToast(`Failed to activate user: ${err.message}`, 'error');
    }
}

async function deactivateUser(userId) {
    try {
        const res = await apiRequest(`/admin/users/${encodeURIComponent(userId)}/deactivate`, {
            method: 'POST'
        });
        showToast(res.message || 'User deactivated.', 'info');
        await Promise.all([loadAdminUsers(), loadAdminStats()]);
    } catch (err) {
        showToast(`Failed to deactivate user: ${err.message}`, 'error');
    }
}

async function loadAdminAccounts() {
    const tbody = document.getElementById('admin-accounts-table-body');
    try {
        const data = await apiRequest('/accounts');
        const accounts = data.accounts || [];

        if (accounts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">No accounts found.</td></tr>';
            return;
        }

        const badgeStyles = {
            ACTIVE: 'bg-emerald-100 text-emerald-800 border-emerald-200',
            FROZEN: 'bg-amber-100 text-amber-800 border-amber-200',
            CLOSED: 'bg-rose-100 text-rose-800 border-rose-200'
        };

        tbody.innerHTML = accounts
            .map(acc => {
                const isSystem = acc.account_type === 'SYSTEM_CLEARING';
                let buttons = '';
                if (isSystem) {
                    buttons = '<span class="text-[11px] text-slate-400">Protected Clearing Vault</span>';
                } else {
                    if (acc.status !== 'ACTIVE') {
                        buttons += `<button onclick="setAccountStatus('${escapeHtml(acc.id)}', 'ACTIVE')" class="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium mr-1">Unfreeze / Activate</button>`;
                    }
                    if (acc.status === 'ACTIVE') {
                        buttons += `<button onclick="setAccountStatus('${escapeHtml(acc.id)}', 'FROZEN')" class="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-medium mr-1">Freeze</button>`;
                    }
                    if (acc.status !== 'CLOSED') {
                        buttons += `<button onclick="setAccountStatus('${escapeHtml(acc.id)}', 'CLOSED')" class="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-medium">Close</button>`;
                    }
                }

                return `
                    <tr class="hover:bg-slate-50">
                        <td class="py-3 px-4 font-mono font-semibold text-slate-800">${escapeHtml(acc.account_number)}</td>
                        <td class="py-3 px-4 text-slate-700">${escapeHtml(acc.owner_username || 'system')}</td>
                        <td class="py-3 px-4 text-[11px] font-mono text-slate-600">${escapeHtml(acc.account_type)}</td>
                        <td class="py-3 px-4 text-right font-mono font-bold text-slate-900">${formatMoney(acc.balance)}</td>
                        <td class="py-3 px-4">
                            <span class="px-2 py-0.5 rounded text-[11px] font-bold border ${badgeStyles[acc.status] || 'bg-slate-100 text-slate-700'}">
                                ${escapeHtml(acc.status)}
                            </span>
                        </td>
                        <td class="py-3 px-4 text-right whitespace-nowrap">${buttons}</td>
                    </tr>
                `;
            })
            .join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-rose-600">${escapeHtml(err.message)}</td></tr>`;
    }
}

async function setAccountStatus(accountId, status) {
    try {
        const res = await apiRequest(`/admin/accounts/${encodeURIComponent(accountId)}/status`, {
            method: 'POST',
            body: JSON.stringify({ status })
        });
        showToast(`Account ${res.account.account_number} is now ${res.account.status}.`, 'success');
        await Promise.all([loadAdminAccounts(), loadAdminStats()]);
    } catch (err) {
        showToast(`Account status update failed: ${err.message}`, 'error');
    }
}

function openAdminCreateUserModal() {
    if (!state.user || state.user.role !== 'ADMIN') {
        showToast('Administrator privileges required.', 'error');
        return;
    }
    document.getElementById('admin-new-username').value = '';
    document.getElementById('admin-new-email').value = '';
    document.getElementById('admin-new-password').value = '';
    document.getElementById('admin-new-role').value = 'ACCOUNT_HOLDER';
    document.getElementById('admin-create-user-modal').classList.remove('hidden');
}

async function handleAdminCreateUser(event) {
    event.preventDefault();
    const username = document.getElementById('admin-new-username').value.trim();
    const email = document.getElementById('admin-new-email').value.trim();
    const password = document.getElementById('admin-new-password').value;
    const role = document.getElementById('admin-new-role').value;

    try {
        const res = await apiRequest('/admin/users', {
            method: 'POST',
            body: JSON.stringify({ username, email, password, role })
        });
        closeModals();
        showToast(`Created active user "${res.username}" (${res.role}).`, 'success');
        await Promise.all([loadAdminUsers(), loadAdminStats()]);
    } catch (err) {
        showToast(`Create user failed: ${err.message}`, 'error');
    }
}

async function resetDemoSeedData() {
    if (!confirm('Reset all demo accounts, balances, and transactions back to initial seeded baseline? (Append-only audit logs are preserved.)')) {
        return;
    }
    try {
        const res = await apiRequest('/admin/reset-seed', { method: 'POST' });
        showToast(res.message || 'Demo database reset cleanly while preserving audit logs.', 'success');
        // Re-authenticate admin with fresh seeded user UUID so the current view continues cleanly
        await loginAs('admin', { silent: true });
        await verifyLedgerConservation();
    } catch (err) {
        showToast(`Reset failed: ${err.message}`, 'error');
    }
}

// ============================================================================
// AUDITOR TAB: CONSERVATION, DOUBLE-ENTRY LEDGER, IMMUTABLE AUDIT LOGS
// ============================================================================

async function verifyLedgerConservation() {
    const headerStatus = document.getElementById('conservation-status-text');
    if (!state.token) {
        if (headerStatus) {
            headerStatus.textContent = 'Sign in to inspect';
            headerStatus.className = 'text-slate-600 font-semibold bg-slate-100 px-2 py-0.5 rounded border border-slate-200';
        }
        return;
    }
    try {
        const data = await apiRequest('/ledger/conservation');
        const ledgerStats = data.ledger_stats || {};
        const balanceStats = data.balance_stats || {};
        const diffFormatted = formatMoney(ledgerStats.difference || 0);

        if (headerStatus) {
            if (data.is_valid) {
                headerStatus.textContent = `Zero-Sum Conserved (Δ = ${diffFormatted})`;
                headerStatus.className = 'text-emerald-700 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200';
            } else {
                headerStatus.textContent = `IMBALANCE DETECTED (Δ = ${diffFormatted})`;
                headerStatus.className = 'text-rose-700 font-semibold bg-rose-50 px-2 py-0.5 rounded border border-rose-200';
            }
        }

        const debitsEl = document.getElementById('audit-total-debits');
        const creditsEl = document.getElementById('audit-total-credits');
        const vaultMatchEl = document.getElementById('audit-vault-match');
        const vaultStatusEl = document.getElementById('audit-vault-status');
        const diffEl = document.getElementById('audit-difference');

        if (debitsEl) debitsEl.textContent = formatMoney(ledgerStats.total_debits || 0);
        if (creditsEl) creditsEl.textContent = formatMoney(ledgerStats.total_credits || 0);
        if (vaultMatchEl) {
            vaultMatchEl.textContent = `${formatMoney(balanceStats.clearing_vault_balance || 0)} = ${formatMoney(balanceStats.total_customer_balances || 0)}`;
        }
        if (vaultStatusEl) {
            vaultStatusEl.textContent = balanceStats.is_consistent
                ? 'Clearing Liability == Customer Equity'
                : 'Vault Mismatch';
        }
        if (diffEl) diffEl.textContent = diffFormatted;
    } catch (err) {
        if (headerStatus) {
            headerStatus.textContent = 'Unavailable';
        }
    }
}

async function loadLedgerEntries() {
    const tbody = document.getElementById('ledger-entries-table-body');
    const txType = document.getElementById('ledger-type-filter').value;
    const direction = document.getElementById('ledger-direction-filter').value;

    const params = new URLSearchParams({ limit: '100' });
    if (txType) params.set('transactionType', txType);
    if (direction) params.set('direction', direction);

    try {
        const data = await apiRequest(`/ledger/entries?${params.toString()}`);
        const entries = data.entries || [];

        if (entries.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">No ledger entries matching filter.</td></tr>';
            return;
        }

        tbody.innerHTML = entries
            .map(e => {
                const isCredit = e.direction === 'CREDIT';
                const badge = isCredit
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                    : 'bg-rose-100 text-rose-800 border-rose-200';
                return `
                    <tr class="hover:bg-slate-50">
                        <td class="py-2.5 px-4 font-mono text-[10px] text-slate-500">${escapeHtml(e.id.slice(0, 8))}...</td>
                        <td class="py-2.5 px-4 font-semibold text-slate-700">${escapeHtml(e.transaction_type)}</td>
                        <td class="py-2.5 px-4 font-mono text-xs text-slate-800">${escapeHtml(e.account_number)}</td>
                        <td class="py-2.5 px-4 text-slate-600">${escapeHtml(e.owner_username || 'system')}</td>
                        <td class="py-2.5 px-4">
                            <span class="px-2 py-0.5 rounded text-[11px] font-bold border ${badge}">${escapeHtml(e.direction)}</span>
                        </td>
                        <td class="py-2.5 px-4 text-right font-mono font-bold text-slate-900">${formatMoney(e.amount)}</td>
                        <td class="py-2.5 px-4 text-slate-500 whitespace-nowrap">${escapeHtml(new Date(e.created_at).toLocaleString())}</td>
                    </tr>
                `;
            })
            .join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-600">${escapeHtml(err.message)}</td></tr>`;
    }
}

async function loadAuditLogs() {
    const tbody = document.getElementById('audit-logs-table-body');
    const statusFilter = document.getElementById('audit-status-filter').value;
    const params = new URLSearchParams({ limit: '100' });
    if (statusFilter) params.set('status', statusFilter);

    try {
        const data = await apiRequest(`/audit/logs?${params.toString()}`);
        const logs = data.logs || [];

        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">No audit entries matching filter.</td></tr>';
            return;
        }

        const statusClasses = {
            SUCCESS: 'bg-emerald-100 text-emerald-800 border-emerald-200',
            FAILURE: 'bg-amber-100 text-amber-800 border-amber-200',
            UNAUTHORIZED: 'bg-rose-100 text-rose-800 border-rose-200'
        };

        tbody.innerHTML = logs
            .map(l => {
                let detailsText = '';
                if (typeof l.details === 'object' && l.details !== null) {
                    detailsText = Object.entries(l.details)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' | ');
                } else if (l.details) {
                    detailsText = String(l.details);
                }

                return `
                    <tr class="hover:bg-slate-50">
                        <td class="py-2.5 px-4 text-slate-500 whitespace-nowrap">${escapeHtml(new Date(l.created_at).toLocaleString())}</td>
                        <td class="py-2.5 px-4 font-semibold text-slate-800">${escapeHtml(l.actor_username || 'system')}</td>
                        <td class="py-2.5 px-4 font-mono text-[10px] text-slate-500">${escapeHtml(l.actor_role || '-')}</td>
                        <td class="py-2.5 px-4 font-mono font-medium text-indigo-700">${escapeHtml(l.action)}</td>
                        <td class="py-2.5 px-4 text-slate-600">${escapeHtml(l.entity_type)}</td>
                        <td class="py-2.5 px-4">
                            <span class="px-2 py-0.5 rounded text-[11px] font-bold border ${statusClasses[l.status] || 'bg-slate-100 text-slate-700'}">
                                ${escapeHtml(l.status)}
                            </span>
                        </td>
                        <td class="py-2.5 px-4 text-slate-600 max-w-md truncate" title="${escapeHtml(detailsText)}">${escapeHtml(detailsText)}</td>
                    </tr>
                `;
            })
            .join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-600">${escapeHtml(err.message)}</td></tr>`;
    }
}

// ============================================================================
// CONCURRENCY STRESS TEST TAB (100 PARALLEL WITHDRAWALS)
// ============================================================================

async function topUpForStressTest() {
    if (!state.user || !state.activeAccountId) {
        showToast('Sign in as Alice or Bob with an active account first.', 'warning');
        return;
    }

    try {
        await apiRequest('/transactions/deposit', {
            method: 'POST',
            headers: { 'Idempotency-Key': generateIdempotencyKey('topup') },
            body: JSON.stringify({
                accountId: state.activeAccountId,
                amount: 10000, // $100.00
                description: 'Stress test top-up ($100.00)'
            })
        });
        showToast('Topped up $100.00 to active account!', 'success');
        await Promise.all([loadUserAccounts(), verifyLedgerConservation()]);
    } catch (err) {
        showToast(`Top-up failed: ${err.message}`, 'error');
    }
}

async function runConcurrencyStressTest() {
    if (!state.user || !state.activeAccountId) {
        showToast('Sign in as an Account Holder (e.g. Alice) before running the stress test.', 'warning');
        return;
    }

    const btn = document.getElementById('btn-run-stress-test');
    const resultsPanel = document.getElementById('stress-test-results');
    const consoleEl = document.getElementById('stress-log-console');

    btn.disabled = true;
    btn.classList.add('opacity-60', 'cursor-not-allowed');
    resultsPanel.classList.remove('hidden');
    consoleEl.textContent = 'Dispatching 100 simultaneous $10.00 withdrawal requests...\n';

    const start = performance.now();
    const requests = Array.from({ length: 100 }, (_, i) => {
        const key = generateIdempotencyKey(`stress-${i}`);
        return fetch(`${API_BASE}/transactions/withdraw`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.token}`,
                'Idempotency-Key': key
            },
            body: JSON.stringify({
                accountId: state.activeAccountId,
                amount: 1000, // $10.00
                description: `Parallel Stress Test Withdrawal #${i + 1}`
            })
        }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    });

    const settled = await Promise.all(requests);
    const elapsedMs = Math.round(performance.now() - start);

    let successCount = 0;
    let insufficientCount = 0;
    let otherFailedCount = 0;
    const sampleLogs = [];

    settled.forEach((res, idx) => {
        if (res.status >= 200 && res.status < 300) {
            successCount++;
            if (sampleLogs.length < 15) {
                sampleLogs.push(`[#${idx + 1}] HTTP ${res.status} OK — $10.00 withdrawn`);
            }
        } else {
            if (res.body && res.body.error === 'INSUFFICIENT_FUNDS') {
                insufficientCount++;
            } else {
                otherFailedCount++;
            }
            if (sampleLogs.length < 25) {
                sampleLogs.push(`[#${idx + 1}] HTTP ${res.status} BLOCKED — ${res.body.error || 'ERROR'}: ${res.body.message || ''}`);
            }
        }
    });

    await Promise.all([loadUserAccounts(), verifyLedgerConservation()]);
    const updatedAcc = state.accounts.find(a => a.id === state.activeAccountId);
    const conservation = await apiRequest('/ledger/conservation');

    document.getElementById('stress-success-count').textContent = String(successCount);
    document.getElementById('stress-failed-count').textContent = String(insufficientCount + otherFailedCount);
    document.getElementById('stress-final-balance').textContent = formatMoney(updatedAcc ? updatedAcc.balance : 0);
    document.getElementById('stress-ledger-status').textContent = conservation.is_valid ? 'BALANCED' : 'IMBALANCED';

    const stressDiff = conservation.ledger_stats ? conservation.ledger_stats.difference || 0 : 0;
    consoleEl.textContent =
        `Completed 100 parallel requests in ${elapsedMs}ms.\n` +
        `Succeeded: ${successCount} | Insufficient Funds Blocked: ${insufficientCount} | Other Blocked: ${otherFailedCount}\n` +
        `Final Account Balance: ${formatMoney(updatedAcc ? updatedAcc.balance : 0)} (never negative)\n` +
        `Double-Entry Delta: ${formatMoney(stressDiff)}\n` +
        `--------------------------------------------------------------\n` +
        sampleLogs.join('\n') +
        (settled.length > sampleLogs.length ? `\n... (${settled.length - sampleLogs.length} more responses omitted)` : '');

    btn.disabled = false;
    btn.classList.remove('opacity-60', 'cursor-not-allowed');
    showToast(`100 parallel withdrawals finished: ${successCount} succeeded, ${insufficientCount + otherFailedCount} safely blocked.`, 'success');
}
