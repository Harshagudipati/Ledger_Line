import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  dollarsToCents,
  downloadStatementCsv,
  formatCents,
  formatDateTime,
  newIdempotencyKey
} from '../api/client.js';
import { BalanceTrajectoryChart } from '../components/Charts.jsx';

export default function HolderDashboard({
  user,
  notify,
  masked = false,
  refreshSignal = 0,
  onInspectTx,
  onOpenLab
}) {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [recipients, setRecipients] = useState([]);
  const [statement, setStatement] = useState(null);
  const [idempotencyHistory, setIdempotencyHistory] = useState([]);
  const [conservation, setConservation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exportingCsv, setExportingCsv] = useState(false);

  // Money movement tab
  const [txTab, setTxTab] = useState('deposit');
  const [amountInput, setAmountInput] = useState('');
  const [description, setDescription] = useState('');
  const [destAccountNumber, setDestAccountNumber] = useState('');
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey('tx'));
  const [lastSubmittedKey, setLastSubmittedKey] = useState('');
  const [txBusy, setTxBusy] = useState(false);

  // Statement filters
  const [filterType, setFilterType] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterFromDate, setFilterFromDate] = useState('');
  const [filterToDate, setFilterToDate] = useState('');

  // Open / Close Account modals
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [newAccType, setNewAccType] = useState('SAVINGS');
  const [openBusy, setOpenBusy] = useState(false);
  const [closeTarget, setCloseTarget] = useState(null);
  const [sweepDestId, setSweepDestId] = useState('');
  const [closeBusy, setCloseBusy] = useState(false);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.status === 'ACTIVE'), [accounts]);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) || accounts[0] || null,
    [accounts, selectedAccountId]
  );

  const loadStatement = useCallback(
    async (accId) => {
      if (!accId) {
        setStatement(null);
        return;
      }
      const params = new URLSearchParams();
      if (filterType) params.set('transactionType', filterType);
      if (filterSearch.trim()) params.set('search', filterSearch.trim());
      if (filterFromDate) params.set('fromDate', filterFromDate);
      if (filterToDate) params.set('toDate', filterToDate);
      const qs = params.toString();
      const stmtData = await apiFetch(`/api/accounts/${accId}/statement${qs ? `?${qs}` : ''}`);
      setStatement(stmtData);
    },
    [filterType, filterSearch, filterFromDate, filterToDate]
  );

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [accRes, consRes, idemRes] = await Promise.all([
        apiFetch('/api/accounts'),
        apiFetch('/api/ledger/conservation'),
        apiFetch('/api/transactions/idempotency?limit=12')
      ]);

      const accList = accRes.accounts || [];
      setAccounts(accList);
      setConservation(consRes);
      setIdempotencyHistory(idemRes.keys || []);

      const currentId =
        selectedAccountId && accList.some((a) => a.id === selectedAccountId)
          ? selectedAccountId
          : accList[0]?.id || '';

      if (currentId !== selectedAccountId) {
        setSelectedAccountId(currentId);
      }

      if (currentId) {
        const [recRes] = await Promise.all([
          apiFetch(`/api/accounts/recipients?excludeAccountId=${encodeURIComponent(currentId)}`),
          loadStatement(currentId)
        ]);
        setRecipients(recRes.recipients || []);
      } else {
        setRecipients([]);
        setStatement(null);
      }
    } catch (err) {
      notify(err.message || 'Failed to load account dashboard.', 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId, loadStatement, notify]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard, refreshSignal]);

  async function handleSelectAccount(accId) {
    setSelectedAccountId(accId);
    try {
      const [recRes] = await Promise.all([
        apiFetch(`/api/accounts/recipients?excludeAccountId=${encodeURIComponent(accId)}`),
        loadStatement(accId)
      ]);
      setRecipients(recRes.recipients || []);
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  async function handleSubmitTransaction(e) {
    e.preventDefault();
    if (!selectedAccount) {
      notify('Select an active account first.', 'error');
      return;
    }

    const cents = dollarsToCents(amountInput);
    if (Number.isNaN(cents)) {
      notify('Enter a valid positive dollar amount (max 2 decimal places).', 'error');
      return;
    }
    if (!idemKey.trim()) {
      notify('Idempotency key is required.', 'error');
      return;
    }

    setTxBusy(true);
    try {
      let endpoint = '/api/transactions/deposit';
      let payload = {
        accountId: selectedAccount.id,
        amount: cents,
        description: description.trim() || undefined
      };

      if (txTab === 'withdraw') {
        endpoint = '/api/transactions/withdraw';
      } else if (txTab === 'transfer') {
        if (!destAccountNumber.trim()) {
          notify('Choose or enter a destination account number.', 'error');
          setTxBusy(false);
          return;
        }
        endpoint = '/api/transactions/transfer';
        payload = {
          sourceAccountId: selectedAccount.id,
          destinationAccountNumber: destAccountNumber.trim(),
          amount: cents,
          description: description.trim() || 'Account Transfer'
        };
      }

      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey.trim() },
        body: payload
      });

      setLastSubmittedKey(idemKey.trim());
      setIdemKey(newIdempotencyKey(txTab.slice(0, 3)));

      if (res.isCached) {
        notify(
          `Idempotent replay served cached result for transaction ${res.transactionId}. Balance unchanged!`,
          'info'
        );
      } else {
        notify(
          `${txTab.toUpperCase()} completed (${formatCents(cents)}). Click statement row to inspect Double-Entry X-Ray.`,
          'success'
        );
        setAmountInput('');
        setDescription('');
      }
      await loadDashboard();
    } catch (err) {
      notify(err.message || 'Transaction failed.', 'error');
    } finally {
      setTxBusy(false);
    }
  }

  async function handleExportStatementCsv() {
    if (!selectedAccount) return;
    setExportingCsv(true);
    try {
      await downloadStatementCsv(selectedAccount.id, selectedAccount.account_number, {
        transactionType: filterType,
        search: filterSearch,
        fromDate: filterFromDate,
        toDate: filterToDate
      });
      notify(`Exported statement CSV for ${selectedAccount.account_number}.`, 'success');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setExportingCsv(false);
    }
  }

  async function handleOpenAccount(e) {
    e.preventDefault();
    setOpenBusy(true);
    try {
      const res = await apiFetch('/api/accounts', {
        method: 'POST',
        body: { accountType: newAccType }
      });
      notify(`Opened new ${res.account.account_type} account (${res.account.account_number}).`, 'success');
      setShowOpenModal(false);
      setSelectedAccountId(res.account.id);
      await loadDashboard();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setOpenBusy(false);
    }
  }

  function openCloseModal(account) {
    const otherActive = activeAccounts.find((a) => a.id !== account.id);
    setSweepDestId(otherActive?.id || '');
    setCloseTarget(account);
  }

  async function handleConfirmClose(e) {
    e.preventDefault();
    if (!closeTarget) return;
    setCloseBusy(true);
    try {
      const body = closeTarget.balance > 0 ? { destinationAccountId: sweepDestId } : {};
      const res = await apiFetch(`/api/accounts/${closeTarget.id}/close`, {
        method: 'POST',
        body
      });
      notify(
        res.sweptAmount > 0
          ? `Closed ${closeTarget.account_number} and swept ${formatCents(res.sweptAmount)} atomically.`
          : `Closed account ${closeTarget.account_number}.`,
        'success'
      );
      setCloseTarget(null);
      await loadDashboard();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setCloseBusy(false);
    }
  }

  const totalLiquidity = accounts.reduce((acc, a) => acc + Number(a.balance || 0), 0);

  return (
    <div className="space-y-6">
      {/* Top KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Welcome Back</div>
          <div className="text-lg font-bold text-white flex items-center gap-2">
            {user.username}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-mono">
              {user.status}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-1 truncate">{user.email}</div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Total Balance</div>
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">
            {formatCents(totalLiquidity, masked)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Across {accounts.length} account{accounts.length === 1 ? '' : 's'}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="text-xs text-slate-400 mb-1">Selected Account</div>
          <div className="text-base font-bold text-white font-mono">
            {selectedAccount ? selectedAccount.account_number : 'None'}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            {selectedAccount ? `${selectedAccount.account_type} · ${selectedAccount.status}` : 'Open an account to start'}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between">
          <div>
            <div className="text-xs text-slate-400 mb-1">ACID Verification Lab</div>
            <div className="text-xs font-semibold text-emerald-400">
              {conservation?.is_valid ? 'Ledger Conserved (Δ = $0.00)' : 'Checking...'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenLab?.(accounts)}
            className="mt-2 px-3 py-1.5 rounded-lg bg-indigo-600/90 hover:bg-indigo-500 text-xs font-semibold text-white text-left flex items-center justify-between transition-colors"
          >
            <span>
              <i className="fa-solid fa-flask-vial mr-1.5" />
              Prove Concurrency & Idempotency
            </span>
            <i className="fa-solid fa-arrow-up-right-from-square text-[10px]" />
          </button>
        </div>
      </div>

      {/* Main Grid: Accounts + Money Movement */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Accounts List */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <i className="fa-solid fa-wallet text-emerald-400" />
                My Accounts
              </h2>
              <button
                type="button"
                onClick={() => setShowOpenModal(true)}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white transition-colors"
              >
                <i className="fa-solid fa-plus mr-1.5" />
                Open Account
              </button>
            </div>

            {loading && accounts.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">Loading accounts...</div>
            ) : accounts.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                No accounts yet. Click &ldquo;Open Account&rdquo; to create one.
              </div>
            ) : (
              <div className="space-y-3">
                {accounts.map((acc) => {
                  const isSelected = selectedAccount?.id === acc.id;
                  const statusColor =
                    acc.status === 'ACTIVE'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : acc.status === 'FROZEN'
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      : 'bg-slate-700/40 text-slate-400 border-slate-600/40';

                  return (
                    <div
                      key={acc.id}
                      onClick={() => handleSelectAccount(acc.id)}
                      className={`p-4 rounded-xl border cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-slate-800/80 border-emerald-500/60 shadow-lg shadow-emerald-950/30'
                          : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-semibold text-white">
                            {acc.account_number}
                          </span>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                            {acc.account_type}
                          </span>
                        </div>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${statusColor}`}>
                          {acc.status}
                        </span>
                      </div>

                      <div className="flex items-end justify-between">
                        <div>
                          <div className="text-xl font-bold text-white tabular-nums">
                            {formatCents(acc.balance, masked)}
                          </div>
                          <div className="text-[11px] text-slate-500">{acc.currency}</div>
                        </div>

                        {acc.status === 'ACTIVE' && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openCloseModal(acc);
                            }}
                            className="px-2.5 py-1 rounded-lg border border-slate-700 hover:border-rose-500/60 hover:text-rose-300 text-[11px] text-slate-400 transition-colors"
                          >
                            Close Account
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Idempotency Replay Ledger */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <i className="fa-solid fa-fingerprint text-sky-400" />
              Recent Idempotency Keys
            </h3>
            {idempotencyHistory.length === 0 ? (
              <p className="text-xs text-slate-500">No idempotent transactions recorded yet.</p>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {idempotencyHistory.map((k) => (
                  <div
                    key={k.key}
                    className="p-2.5 rounded-lg bg-slate-950/70 border border-slate-800/80 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-slate-200 truncate">{k.key}</div>
                      <div className="text-[10px] text-slate-500">
                        {k.request_path} · {formatDateTime(k.created_at)}
                      </div>
                    </div>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded font-semibold shrink-0 ${
                        k.status === 'COMPLETED'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : k.status === 'FAILED'
                          ? 'bg-rose-500/15 text-rose-300'
                          : 'bg-amber-500/15 text-amber-300'
                      }`}
                    >
                      {k.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Money Movement Form + Trajectory Chart + Statement */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <i className="fa-solid fa-money-bill-transfer text-emerald-400" />
                Execute Ledger Transaction
              </h2>
              <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
                {['deposit', 'withdraw', 'transfer'].map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => {
                      setTxTab(tab);
                      setIdemKey(newIdempotencyKey(tab.slice(0, 3)));
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${
                      txTab === tab
                        ? 'bg-emerald-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            {selectedAccount && selectedAccount.status !== 'ACTIVE' ? (
              <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-800/70 text-amber-200 text-xs">
                Selected account <strong>{selectedAccount.account_number}</strong> is{' '}
                <strong>{selectedAccount.status}</strong>. Transactions are disabled unless an Administrator activates it.
              </div>
            ) : (
              <form onSubmit={handleSubmitTransaction} className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Amount (USD)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      required
                      placeholder="e.g. 125.50"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white font-mono focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Memo / Description
                    </label>
                    <input
                      type="text"
                      placeholder={
                        txTab === 'deposit'
                          ? 'Cash Deposit'
                          : txTab === 'withdraw'
                          ? 'ATM Cash'
                          : 'Peer Transfer'
                      }
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>

                {txTab === 'transfer' && (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Quick Pick Active Recipient
                      </label>
                      <select
                        value={destAccountNumber}
                        onChange={(e) => setDestAccountNumber(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500"
                      >
                        <option value="">-- Select Recipient Account --</option>
                        {recipients.map((r) => (
                          <option key={r.id} value={r.account_number}>
                            {r.owner_username} — {r.account_number} ({r.account_type})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Or Destination Account Number
                      </label>
                      <input
                        type="text"
                        placeholder="ACC-12345678"
                        value={destAccountNumber}
                        onChange={(e) => setDestAccountNumber(e.target.value)}
                        className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white font-mono focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>
                )}

                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-[11px] font-medium text-slate-400">
                      Header <code className="text-sky-300">Idempotency-Key</code>
                    </label>
                    <div className="flex gap-2">
                      {lastSubmittedKey && (
                        <button
                          type="button"
                          onClick={() => setIdemKey(lastSubmittedKey)}
                          className="text-[11px] px-2 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 hover:bg-sky-500/25"
                        >
                          Replay Last Key
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setIdemKey(newIdempotencyKey(txTab.slice(0, 3)))}
                        className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 hover:text-white"
                      >
                        Regenerate UUID
                      </button>
                    </div>
                  </div>
                  <input
                    type="text"
                    required
                    value={idemKey}
                    onChange={(e) => setIdemKey(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-sky-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={txBusy || !selectedAccount}
                  className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white transition-colors"
                >
                  {txBusy ? 'Processing Atomic Ledger Entry...' : `Submit ${txTab.toUpperCase()}`}
                </button>
              </form>
            )}
          </div>

          {/* Interactive SVG Balance Curve */}
          <BalanceTrajectoryChart
            entries={statement?.statement_entries || []}
            masked={masked}
            onSelectTx={(txId) => onInspectTx?.(txId)}
          />

          {/* Filtered Statement Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <i className="fa-solid fa-file-invoice-dollar text-emerald-400" />
                  Account Statement & Running Balance
                </h2>
                {statement && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    Ledger check:{' '}
                    <span className={statement.is_balance_consistent ? 'text-emerald-400' : 'text-rose-400'}>
                      {statement.is_balance_consistent ? 'VERIFIED' : 'MISMATCH'}
                    </span>{' '}
                    ({statement.statement_entries.length} of {statement.total_unfiltered_entries} entries · click any row for X-Ray)
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!selectedAccount || exportingCsv}
                  onClick={handleExportStatementCsv}
                  className="px-3 py-1.5 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 disabled:opacity-50 text-xs font-semibold text-white"
                >
                  <i className="fa-solid fa-file-csv mr-1.5" />
                  {exportingCsv ? 'Exporting...' : 'CSV'}
                </button>
                <button
                  type="button"
                  onClick={() => selectedAccount && loadStatement(selectedAccount.id)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200"
                >
                  <i className="fa-solid fa-rotate mr-1.5" />
                  Refresh
                </button>
              </div>
            </div>

            {/* Statement Filters */}
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5 mb-4">
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
              >
                <option value="">All Types</option>
                <option value="DEPOSIT">DEPOSIT</option>
                <option value="WITHDRAWAL">WITHDRAWAL</option>
                <option value="TRANSFER">TRANSFER</option>
              </select>
              <input
                type="text"
                placeholder="Search memo or key..."
                value={filterSearch}
                onChange={(e) => setFilterSearch(e.target.value)}
                className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
              />
              <input
                type="date"
                value={filterFromDate}
                onChange={(e) => setFilterFromDate(e.target.value)}
                className="px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
                title="From Date"
              />
              <div className="flex gap-2">
                <input
                  type="date"
                  value={filterToDate}
                  onChange={(e) => setFilterToDate(e.target.value)}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
                  title="To Date"
                />
                {(filterType || filterSearch || filterFromDate || filterToDate) && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilterType('');
                      setFilterSearch('');
                      setFilterFromDate('');
                      setFilterToDate('');
                    }}
                    className="px-2.5 py-2 rounded-lg border border-slate-700 text-xs text-slate-300 hover:text-white"
                    title="Clear filters"
                  >
                    <i className="fa-solid fa-xmark" />
                  </button>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 pr-3">Timestamp</th>
                    <th className="py-2.5 pr-3">Type</th>
                    <th className="py-2.5 pr-3">Description</th>
                    <th className="py-2.5 pr-3 text-right">Amount</th>
                    <th className="py-2.5 text-right">Running Bal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {!statement || statement.statement_entries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-slate-500">
                        No matching ledger entries found.
                      </td>
                    </tr>
                  ) : (
                    [...statement.statement_entries].reverse().map((row) => {
                      const isCredit = row.direction === 'CREDIT';
                      return (
                        <tr
                          key={row.entry_id}
                          onClick={() => onInspectTx?.(row.transaction_id)}
                          className="hover:bg-slate-800/50 cursor-pointer transition-colors"
                          title="Click to inspect Double-Entry X-Ray"
                        >
                          <td className="py-2.5 pr-3 text-slate-400 whitespace-nowrap">
                            {formatDateTime(row.created_at)}
                          </td>
                          <td className="py-2.5 pr-3">
                            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-mono text-[10px]">
                              {row.transaction_type}
                            </span>
                          </td>
                          <td className="py-2.5 pr-3 text-slate-200">
                            <div className="flex items-center gap-1.5">
                              <span>{row.description || '—'}</span>
                              <i className="fa-solid fa-magnifying-glass-chart text-[10px] text-sky-400/70" />
                            </div>
                            <div className="text-[10px] font-mono text-slate-500">{row.idempotency_key}</div>
                          </td>
                          <td
                            className={`py-2.5 pr-3 text-right font-mono font-semibold tabular-nums whitespace-nowrap ${
                              isCredit ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {isCredit ? '+' : '-'}
                            {formatCents(row.amount, masked)}
                          </td>
                          <td className="py-2.5 text-right font-mono text-slate-200 tabular-nums whitespace-nowrap">
                            {formatCents(row.running_balance, masked)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* Open Account Modal */}
      {showOpenModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full p-6">
            <h3 className="text-base font-semibold text-white mb-2">Open Additional Account</h3>
            <p className="text-xs text-slate-400 mb-4">
              Each new account initializes with a zero balance and generates a unique account number.
            </p>
            <form onSubmit={handleOpenAccount} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Account Type</label>
                <select
                  value={newAccType}
                  onChange={(e) => setNewAccType(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white"
                >
                  <option value="SAVINGS">SAVINGS</option>
                  <option value="CHECKING">CHECKING</option>
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowOpenModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-700 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={openBusy}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white"
                >
                  {openBusy ? 'Creating...' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Close Account + Atomic Balance Sweep Modal */}
      {closeTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6">
            <h3 className="text-base font-semibold text-white mb-2">
              Close Account {closeTarget.account_number}
            </h3>
            <p className="text-xs text-slate-400 mb-4">
              Current balance:{' '}
              <strong className="text-white">{formatCents(closeTarget.balance, masked)}</strong>.
              Closing an account is permanent and preserves full historical ledger entries.
            </p>
            <form onSubmit={handleConfirmClose} className="space-y-4">
              {closeTarget.balance > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Sweep Remaining Balance To
                  </label>
                  <select
                    required
                    value={sweepDestId}
                    onChange={(e) => setSweepDestId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-sm text-white"
                  >
                    <option value="">-- Choose Destination Account --</option>
                    {activeAccounts
                      .filter((a) => a.id !== closeTarget.id)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.account_number} ({a.account_type} · {formatCents(a.balance, masked)})
                        </option>
                      ))}
                    {recipients
                      .filter((r) => r.id !== closeTarget.id)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.owner_username} — {r.account_number} ({r.account_type})
                        </option>
                      ))}
                  </select>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCloseTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-700 text-xs text-slate-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={closeBusy || (closeTarget.balance > 0 && !sweepDestId)}
                  className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-xs font-semibold text-white"
                >
                  {closeBusy
                    ? 'Closing...'
                    : closeTarget.balance > 0
                    ? `Sweep ${formatCents(closeTarget.balance)} & Close`
                    : 'Confirm Close'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
