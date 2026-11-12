import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch, formatCents, formatDateTime } from '../api/client.js';

export default function AdminDashboard({ user, notify }) {
  const [stats, setStats] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [conservation, setConservation] = useState(null);
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [userFilter, setUserFilter] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Create user modal
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('AUDITOR');
  const [creating, setCreating] = useState(false);

  // Reset confirmation modal
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, metricsRes, consRes, usersRes, accRes] = await Promise.all([
        apiFetch('/api/admin/stats'),
        apiFetch('/api/metrics'),
        apiFetch('/api/ledger/conservation'),
        apiFetch('/api/admin/users'),
        apiFetch('/api/accounts')
      ]);
      setStats(statsRes.stats);
      setMetrics(metricsRes);
      setConservation(consRes);
      setUsers(usersRes.users || []);
      setAccounts(accRes.accounts || []);
    } catch (err) {
      notify(err.message || 'Failed to load admin console.', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  async function handleUserAction(targetUser, action) {
    try {
      await apiFetch(`/api/admin/users/${targetUser.id}/${action}`, { method: 'POST' });
      notify(
        `User '${targetUser.username}' ${action === 'activate' ? 'activated / unlocked' : 'deactivated'}.`,
        'success'
      );
      await loadAdminData();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function handleAccountStatus(acc, nextStatus) {
    try {
      await apiFetch(`/api/admin/accounts/${acc.id}/status`, {
        method: 'POST',
        body: { status: nextStatus }
      });
      notify(`Account ${acc.account_number} marked ${nextStatus}.`, 'success');
      await loadAdminData();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    setCreating(true);
    try {
      const created = await apiFetch('/api/admin/users', {
        method: 'POST',
        body: {
          username: newUsername.trim(),
          email: newEmail.trim(),
          password: newPassword,
          role: newRole
        }
      });
      notify(`Provisioned ${created.role} '${created.username}' as ACTIVE.`, 'success');
      setShowCreateUser(false);
      setNewUsername('');
      setNewEmail('');
      setNewPassword('');
      await loadAdminData();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleResetDemo() {
    setResetBusy(true);
    try {
      await apiFetch('/api/admin/reset-seed', { method: 'POST' });
      notify('Demo ledger reset cleanly; immutable audit_logs preserved.', 'success');
      setShowResetConfirm(false);
      await loadAdminData();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setResetBusy(false);
    }
  }

  const filteredUsers = users.filter((u) => {
    if (!userFilter) return true;
    return u.status === userFilter || u.role === userFilter;
  });

  const filteredAccounts = accounts.filter((a) => {
    if (!accountSearch.trim()) return true;
    const q = accountSearch.toLowerCase();
    return (
      a.account_number.toLowerCase().includes(q) ||
      (a.owner_username || '').toLowerCase().includes(q) ||
      a.status.toLowerCase().includes(q)
    );
  });

  const pendingUsers = users.filter((u) => u.status === 'PENDING_APPROVAL');

  return (
    <div className="space-y-6">
      {/* KPI & Telemetry Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Total Customer Liquidity</div>
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">
            {formatCents(conservation?.balance_stats?.total_customer_balances)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Clearing Vault: {formatCents(conservation?.balance_stats?.clearing_vault_balance)}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Platform Users & Pending</div>
          <div className="text-2xl font-bold text-white tabular-nums">
            {stats?.users?.total_users ?? '—'}
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">
              {stats?.users?.pending_users ?? 0} pending
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Active Accounts: {stats?.accounts?.active_accounts ?? '—'}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Double-Entry Invariance</div>
          <div className="text-lg font-bold">
            {conservation?.is_valid ? (
              <span className="text-emerald-400">
                <i className="fa-solid fa-shield-check mr-1.5" />
                CONSERVED (Δ = $0.00)
              </span>
            ) : (
              <span className="text-rose-400">VERIFYING...</span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Tx Count: {stats?.transactions?.total_transactions ?? '—'}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Runtime Telemetry</div>
          <div className="text-sm font-bold text-sky-400 font-mono">
            {metrics ? `${metrics.totalRequests} reqs · ${metrics.avgLatencyMs}ms avg` : '—'}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono">
            DB: {metrics?.backends?.database || '—'} · RL: {metrics?.backends?.rateLimiter || '—'}
          </div>
        </div>
      </div>

      {/* Action Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/70 border border-slate-800 rounded-2xl p-4">
        <div className="text-xs text-slate-300">
          <strong className="text-white">Administrator Controls:</strong> Approve/unlock users, provision privileged roles, freeze/unfreeze accounts, and verify conservation invariants.
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={loadAdminData}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200"
          >
            <i className="fa-solid fa-rotate mr-1.5" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowCreateUser(true)}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white"
          >
            <i className="fa-solid fa-user-plus mr-1.5" />
            Provision User
          </button>
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="px-3 py-1.5 rounded-lg border border-amber-700/80 bg-amber-950/40 hover:bg-amber-900/50 text-xs font-semibold text-amber-200"
          >
            <i className="fa-solid fa-arrows-rotate mr-1.5" />
            Reset Demo State
          </button>
        </div>
      </div>

      {/* Pending Onboarding Banner if any */}
      {pendingUsers.length > 0 && (
        <div className="bg-amber-950/30 border border-amber-800/70 rounded-2xl p-5">
          <h3 className="text-sm font-semibold text-amber-300 mb-3 flex items-center gap-2">
            <i className="fa-solid fa-user-clock" />
            Pending Onboarding Approvals ({pendingUsers.length})
          </h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingUsers.map((pu) => (
              <div
                key={pu.id}
                className="p-3.5 rounded-xl bg-slate-900/90 border border-amber-800/40 flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white truncate">{pu.username}</div>
                  <div className="text-[11px] text-slate-400 truncate">{pu.email}</div>
                </div>
                <button
                  type="button"
                  onClick={() => handleUserAction(pu, 'activate')}
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white shrink-0"
                >
                  Approve
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* User Management Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <i className="fa-solid fa-users-gear text-emerald-400" />
            User Directory & Access Governance
          </h2>
          <select
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
          >
            <option value="">All Roles & Statuses</option>
            <option value="PENDING_APPROVAL">PENDING_APPROVAL</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="DEACTIVATED">DEACTIVATED</option>
            <option value="ADMIN">Role: ADMIN</option>
            <option value="AUDITOR">Role: AUDITOR</option>
            <option value="ACCOUNT_HOLDER">Role: ACCOUNT_HOLDER</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-2.5 pr-3">User</th>
                <th className="py-2.5 pr-3">Role</th>
                <th className="py-2.5 pr-3">Status / Lockout</th>
                <th className="py-2.5 pr-3">Created</th>
                <th className="py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading && users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500">Loading users...</td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const isLocked = u.locked_until && new Date(u.locked_until).getTime() > Date.now();
                  return (
                    <tr key={u.id} className="hover:bg-slate-800/30">
                      <td className="py-2.5 pr-3">
                        <div className="font-semibold text-white">{u.username}</div>
                        <div className="text-[11px] text-slate-400">{u.email}</div>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-200">{u.role}</td>
                      <td className="py-2.5 pr-3">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                            u.status === 'ACTIVE'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                              : u.status === 'PENDING_APPROVAL'
                              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                              : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                          }`}
                        >
                          {u.status}
                        </span>
                        {isLocked && (
                          <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-950 text-rose-300 border border-rose-700">
                            LOCKED ({u.failed_login_attempts} fails)
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-400">{formatDateTime(u.created_at)}</td>
                      <td className="py-2.5 text-right space-x-2 whitespace-nowrap">
                        {(u.status !== 'ACTIVE' || isLocked) && (
                          <button
                            type="button"
                            onClick={() => handleUserAction(u, 'activate')}
                            className="px-2.5 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] font-semibold"
                          >
                            {isLocked ? 'Unlock / Activate' : 'Activate'}
                          </button>
                        )}
                        {u.status === 'ACTIVE' && u.id !== user.id && (
                          <button
                            type="button"
                            onClick={() => handleUserAction(u, 'deactivate')}
                            className="px-2.5 py-1 rounded border border-rose-700/80 text-rose-300 hover:bg-rose-950/60 text-[11px]"
                          >
                            Deactivate
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Global Accounts & Freeze Control */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <i className="fa-solid fa-snowflake text-sky-400" />
            Platform Accounts & Freeze Controls
          </h2>
          <input
            type="text"
            placeholder="Search account # or owner..."
            value={accountSearch}
            onChange={(e) => setAccountSearch(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400 border-b border-slate-800">
              <tr>
                <th className="py-2.5 pr-3">Account #</th>
                <th className="py-2.5 pr-3">Owner</th>
                <th className="py-2.5 pr-3">Type</th>
                <th className="py-2.5 pr-3">Status</th>
                <th className="py-2.5 pr-3 text-right">Balance</th>
                <th className="py-2.5 text-right">Compliance Control</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {filteredAccounts.map((acc) => {
                const isClearing = acc.account_type === 'SYSTEM_CLEARING';
                return (
                  <tr key={acc.id} className="hover:bg-slate-800/30">
                    <td className="py-2.5 pr-3 font-mono font-semibold text-white">{acc.account_number}</td>
                    <td className="py-2.5 pr-3 text-slate-300">{acc.owner_username}</td>
                    <td className="py-2.5 pr-3 text-slate-400">{acc.account_type}</td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          acc.status === 'ACTIVE'
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : acc.status === 'FROZEN'
                            ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                            : 'bg-slate-700/40 text-slate-400 border-slate-600/40'
                        }`}
                      >
                        {acc.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-right font-mono tabular-nums text-white">
                      {formatCents(acc.balance)}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {isClearing ? (
                        <span className="text-[11px] text-slate-500">System Root</span>
                      ) : acc.status === 'ACTIVE' ? (
                        <button
                          type="button"
                          onClick={() => handleAccountStatus(acc, 'FROZEN')}
                          className="px-2.5 py-1 rounded border border-amber-700/80 text-amber-300 hover:bg-amber-950/60 text-[11px]"
                        >
                          Freeze
                        </button>
                      ) : acc.status === 'FROZEN' ? (
                        <button
                          type="button"
                          onClick={() => handleAccountStatus(acc, 'ACTIVE')}
                          className="px-2.5 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white text-[11px] font-semibold"
                        >
                          Unfreeze
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-500">Closed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6">
            <h3 className="text-base font-semibold text-white mb-4">Provision Platform User</h3>
            <form onSubmit={handleCreateUser} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Username</label>
                <input
                  type="text"
                  required
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Role</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white"
                >
                  <option value="AUDITOR">AUDITOR</option>
                  <option value="ADMIN">ADMIN</option>
                  <option value="ACCOUNT_HOLDER">ACCOUNT_HOLDER</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Initial Password (min 8 chars)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateUser(false)}
                  className="px-4 py-2 rounded-lg border border-slate-700 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white"
                >
                  {creating ? 'Provisioning...' : 'Create ACTIVE User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Demo Confirm Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6">
            <h3 className="text-base font-semibold text-amber-300 mb-2">
              Confirm Demo Ledger Reset
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              This clears current transactional balances back to the initial seeded baseline while strictly preserving every row in the append-only <code className="text-emerald-300">audit_logs</code> table and recording a <code className="text-amber-300">DEMO_DATABASE_RESET</code> event.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowResetConfirm(false)}
                className="px-4 py-2 rounded-lg border border-slate-700 text-xs text-slate-300"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={resetBusy}
                onClick={handleResetDemo}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-xs font-semibold text-white"
              >
                {resetBusy ? 'Resetting...' : 'Reset Baseline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
