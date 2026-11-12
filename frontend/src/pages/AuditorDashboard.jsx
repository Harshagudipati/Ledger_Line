import React, { useCallback, useEffect, useState } from 'react';
import {
  apiFetch,
  downloadAuditCsv,
  formatCents,
  formatDateTime
} from '../api/client.js';

export default function AuditorDashboard({
  notify,
  masked = false,
  refreshSignal = 0,
  onInspectTx
}) {
  const [conservation, setConservation] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [chainProof, setChainProof] = useState(null);
  const [verifyingChain, setVerifyingChain] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [ledgerEntries, setLedgerEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Audit Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Ledger Entry Filters
  const [txTypeFilter, setTxTypeFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState('');

  const loadCompliance = useCallback(async () => {
    setLoading(true);
    try {
      const auditParams = new URLSearchParams({ limit: '100' });
      if (statusFilter) auditParams.set('status', statusFilter);
      if (entityFilter) auditParams.set('entityType', entityFilter);
      if (searchFilter.trim()) auditParams.set('search', searchFilter.trim());
      if (fromDate) auditParams.set('fromDate', fromDate);
      if (toDate) auditParams.set('toDate', toDate);

      const ledgerParams = new URLSearchParams({ limit: '100' });
      if (txTypeFilter) ledgerParams.set('transactionType', txTypeFilter);
      if (directionFilter) ledgerParams.set('direction', directionFilter);

      const [consRes, metRes, audRes, ledRes, chainRes] = await Promise.all([
        apiFetch('/api/ledger/conservation'),
        apiFetch('/api/metrics'),
        apiFetch(`/api/audit/logs?${auditParams.toString()}`),
        apiFetch(`/api/ledger/entries?${ledgerParams.toString()}`),
        apiFetch('/api/audit/verify-chain')
      ]);

      setConservation(consRes);
      setMetrics(metRes);
      setAuditLogs(audRes.logs || []);
      setAuditTotal(audRes.total || 0);
      setLedgerEntries(ledRes.entries || []);
      setChainProof(chainRes);
    } catch (err) {
      notify(err.message || 'Failed to load compliance explorer.', 'error');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, entityFilter, searchFilter, fromDate, toDate, txTypeFilter, directionFilter, notify]);

  useEffect(() => {
    loadCompliance();
  }, [loadCompliance, refreshSignal]);

  async function handleVerifyChain() {
    setVerifyingChain(true);
    try {
      const res = await apiFetch('/api/audit/verify-chain');
      setChainProof(res);
      notify(
        res.valid
          ? `Cryptographic SHA-256 chain verified across ${res.verifiedEntries} audit links!`
          : `Chain tamper detected at ${res.brokenAtId}: ${res.reason}`,
        res.valid ? 'success' : 'error'
      );
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setVerifyingChain(false);
    }
  }

  async function handleExportCsv() {
    setExporting(true);
    try {
      await downloadAuditCsv({
        status: statusFilter,
        entityType: entityFilter,
        search: searchFilter,
        fromDate,
        toDate
      });
      notify('Audit log CSV export downloaded.', 'success');
    } catch (err) {
      notify(err.message || 'CSV export failed.', 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Conservation Proof Banner */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">System Conservation Proof</div>
          <div className="text-lg font-bold">
            {conservation?.is_valid ? (
              <span className="text-emerald-400">
                <i className="fa-solid fa-check-double mr-1.5" />
                PERFECTLY BALANCED
              </span>
            ) : (
              <span className="text-rose-400">DISCREPANCY</span>
            )}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Imbalance: {formatCents(conservation?.ledger_stats?.difference || 0, masked)}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Total Debits / Credits</div>
          <div className="text-base font-bold text-white font-mono tabular-nums">
            {formatCents(conservation?.ledger_stats?.total_debits, masked)} /{' '}
            {formatCents(conservation?.ledger_stats?.total_credits, masked)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Ledger Legs: {conservation?.ledger_stats?.total_entries ?? '—'}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Customer vs Clearing Vault</div>
          <div className="text-base font-bold text-emerald-400 font-mono tabular-nums">
            {formatCents(conservation?.balance_stats?.total_customer_balances, masked)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Clearing Mirror: {formatCents(conservation?.balance_stats?.clearing_vault_balance, masked)}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
          <div>
            <div className="text-xs text-slate-400 mb-1">SHA-256 Hash Chain Integrity</div>
            <div className="text-sm font-bold flex items-center gap-1.5">
              {chainProof?.valid ? (
                <span className="text-emerald-400">
                  <i className="fa-solid fa-link" />
                  INTACT ({chainProof.verifiedEntries} links)
                </span>
              ) : chainProof ? (
                <span className="text-rose-400">BROKEN</span>
              ) : (
                <span className="text-slate-400">CHECKING...</span>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={verifyingChain}
            onClick={handleVerifyChain}
            className="mt-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-semibold text-sky-300 text-left flex items-center justify-between"
          >
            <span>{verifyingChain ? 'Verifying...' : 'Re-Verify SHA-256 Chain'}</span>
            <i className="fa-solid fa-shield-halved" />
          </button>
        </div>
      </div>

      {/* Head Hash & Runtime Security Strip */}
      {chainProof && (
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-slate-400 shrink-0">Head Chain Hash:</span>
            <code className="font-mono text-[11px] text-emerald-300 truncate">{chainProof.headHash}</code>
          </div>
          <div className="text-slate-400 font-mono text-[11px]">
            Auth Fails: {metrics?.authFailures ?? 0} · Rate Limit 429s: {metrics?.rateLimitBlocks ?? 0}
          </div>
        </div>
      )}

      {/* Immutable Audit Logs Section */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <i className="fa-solid fa-scroll text-emerald-400" />
              Append-Only Compliance Audit Log ({auditTotal} matching)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Protected by DB UPDATE/DELETE immutability triggers & SHA-256 hash chaining
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={loadCompliance}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200"
            >
              <i className="fa-solid fa-rotate mr-1.5" />
              Refresh
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={handleExportCsv}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-semibold text-white"
            >
              <i className="fa-solid fa-file-csv mr-1.5" />
              {exporting ? 'Exporting...' : 'Export CSV'}
            </button>
          </div>
        </div>

        {/* Audit Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5 mb-4">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
          >
            <option value="">All Statuses</option>
            <option value="SUCCESS">SUCCESS</option>
            <option value="FAILURE">FAILURE</option>
            <option value="UNAUTHORIZED">UNAUTHORIZED</option>
          </select>
          <select
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
          >
            <option value="">All Entities</option>
            <option value="AUTH">AUTH</option>
            <option value="USER">USER</option>
            <option value="ACCOUNT">ACCOUNT</option>
            <option value="TRANSACTION">TRANSACTION</option>
            <option value="SYSTEM">SYSTEM</option>
          </select>
          <input
            type="text"
            placeholder="Search actor, action, details..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
          />
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
          />
          <div className="flex gap-2">
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
            />
            {(statusFilter || entityFilter || searchFilter || fromDate || toDate) && (
              <button
                type="button"
                onClick={() => {
                  setStatusFilter('');
                  setEntityFilter('');
                  setSearchFilter('');
                  setFromDate('');
                  setToDate('');
                }}
                className="px-2.5 py-2 rounded-lg border border-slate-700 text-xs text-slate-300"
              >
                <i className="fa-solid fa-xmark" />
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400 border-b border-slate-800 sticky top-0 bg-slate-900">
              <tr>
                <th className="py-2.5 pr-3">Timestamp</th>
                <th className="py-2.5 pr-3">Actor</th>
                <th className="py-2.5 pr-3">Action</th>
                <th className="py-2.5 pr-3">Status</th>
                <th className="py-2.5 pr-3">Entry Hash</th>
                <th className="py-2.5">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading && auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">Loading audit logs...</td>
                </tr>
              ) : auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">No matching audit events.</td>
                </tr>
              ) : (
                auditLogs.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-800/30">
                    <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">{formatDateTime(l.created_at)}</td>
                    <td className="py-2 pr-3 text-slate-200 whitespace-nowrap">
                      {l.actor_username || 'system'}{' '}
                      {l.actor_role && <span className="text-[10px] text-slate-500">({l.actor_role})</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-sky-300 whitespace-nowrap">{l.action}</td>
                    <td className="py-2 pr-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          l.status === 'SUCCESS'
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : l.status === 'UNAUTHORIZED'
                            ? 'bg-amber-500/15 text-amber-300'
                            : 'bg-rose-500/15 text-rose-300'
                        }`}
                      >
                        {l.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-[10px] text-emerald-400/80 whitespace-nowrap">
                      {l.entry_hash ? `${l.entry_hash.slice(0, 12)}…` : 'legacy'}
                    </td>
                    <td className="py-2 font-mono text-[11px] text-slate-400 max-w-md truncate">
                      {typeof l.details === 'object' && l.details !== null ? JSON.stringify(l.details) : l.details || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Double-Entry Ledger Inspector */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <i className="fa-solid fa-book text-sky-400" />
              Double-Entry Ledger Entries Inspector
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5">Click any row to open full Transaction X-Ray</p>
          </div>
          <div className="flex gap-2">
            <select
              value={txTypeFilter}
              onChange={(e) => setTxTypeFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
            >
              <option value="">All Tx Types</option>
              <option value="DEPOSIT">DEPOSIT</option>
              <option value="WITHDRAWAL">WITHDRAWAL</option>
              <option value="TRANSFER">TRANSFER</option>
            </select>
            <select
              value={directionFilter}
              onChange={(e) => setDirectionFilter(e.target.value)}
              className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
            >
              <option value="">DEBIT & CREDIT</option>
              <option value="DEBIT">DEBIT only</option>
              <option value="CREDIT">CREDIT only</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-400 border-b border-slate-800 sticky top-0 bg-slate-900">
              <tr>
                <th className="py-2.5 pr-3">Timestamp</th>
                <th className="py-2.5 pr-3">Transaction ID</th>
                <th className="py-2.5 pr-3">Tx Type</th>
                <th className="py-2.5 pr-3">Account</th>
                <th className="py-2.5 pr-3">Direction</th>
                <th className="py-2.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {ledgerEntries.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => onInspectTx?.(e.transaction_id)}
                  className="hover:bg-slate-800/50 cursor-pointer transition-colors"
                >
                  <td className="py-2 pr-3 text-slate-400 whitespace-nowrap">{formatDateTime(e.created_at)}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-sky-300">{e.transaction_id}</td>
                  <td className="py-2 pr-3 font-mono text-[11px] text-slate-200">{e.transaction_type}</td>
                  <td className="py-2 pr-3 text-slate-300">
                    <span className="font-mono">{e.account_number}</span>{' '}
                    <span className="text-slate-500">({e.owner_username})</span>
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold ${
                        e.direction === 'CREDIT'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-amber-500/15 text-amber-300'
                      }`}
                    >
                      {e.direction}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono text-white tabular-nums">
                    {formatCents(e.amount, masked)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
