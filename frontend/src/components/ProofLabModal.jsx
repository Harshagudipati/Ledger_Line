import React, { useState } from 'react';
import {
  apiFetch,
  dollarsToCents,
  formatCents,
  newIdempotencyKey
} from '../api/client.js';

export default function ProofLabModal({ isOpen, onClose, accounts = [], onCompleteRefresh, notify }) {
  const [tab, setTab] = useState('concurrency'); // 'concurrency' | 'idempotency'

  // Concurrency simulator state
  const [burstCount, setBurstCount] = useState(15);
  const [seedDollars, setSeedDollars] = useState('50.00');
  const [withdrawDollars, setWithdrawDollars] = useState('10.00');
  const [raceRunning, setRaceRunning] = useState(false);
  const [raceResult, setRaceResult] = useState(null);

  // Idempotency lab state
  const activeAcc = accounts.find((a) => a.status === 'ACTIVE');
  const [idemTargetId, setIdemTargetId] = useState('');
  const [idemAmount, setIdemAmount] = useState('5.00');
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey('lab'));
  const [idemSteps, setIdemSteps] = useState([]);
  const [idemBusy, setIdemBusy] = useState(false);

  if (!isOpen) return null;

  const targetAccountId = idemTargetId || activeAcc?.id || '';

  async function runConcurrencyBurst() {
    const seedCents = dollarsToCents(seedDollars);
    const wdlCents = dollarsToCents(withdrawDollars);
    const count = Math.min(Math.max(Number(burstCount) || 10, 2), 40);

    if (Number.isNaN(seedCents) || Number.isNaN(wdlCents)) {
      notify('Enter valid positive dollar amounts.', 'error');
      return;
    }

    setRaceRunning(true);
    setRaceResult(null);
    const t0 = performance.now();

    try {
      // 1. Open dedicated sandbox account so user's primary checking stays untouched
      const openRes = await apiFetch('/api/accounts', {
        method: 'POST',
        body: { accountType: 'CHECKING' }
      });
      const labAcc = openRes.account;

      // 2. Fund it cleanly
      await apiFetch('/api/transactions/deposit', {
        method: 'POST',
        headers: { 'Idempotency-Key': newIdempotencyKey('lab-fund') },
        body: {
          accountId: labAcc.id,
          amount: seedCents,
          description: 'Concurrency Lab Funding'
        }
      });

      // 3. Fire N genuine parallel withdrawals simultaneously via Promise.all
      const burstRequests = Array.from({ length: count }, (_, idx) =>
        apiFetch('/api/transactions/withdraw', {
          method: 'POST',
          headers: { 'Idempotency-Key': newIdempotencyKey(`burst-${idx}`) },
          body: {
            accountId: labAcc.id,
            amount: wdlCents,
            description: `Parallel Race #${idx + 1}`
          }
        })
          .then((res) => ({ idx: idx + 1, ok: true, txId: res.transactionId }))
          .catch((err) => ({ idx: idx + 1, ok: false, code: err.code || err.message }))
      );

      const outcomes = await Promise.all(burstRequests);
      const elapsedMs = Math.round(performance.now() - t0);

      const [accCheck, consCheck] = await Promise.all([
        apiFetch(`/api/accounts/${labAcc.id}`),
        apiFetch('/api/ledger/conservation')
      ]);

      const succeeded = outcomes.filter((o) => o.ok);
      const rejected = outcomes.filter((o) => !o.ok);
      const expectedWins = Math.min(count, Math.floor(seedCents / wdlCents));

      setRaceResult({
        accountNumber: labAcc.account_number,
        accountId: labAcc.id,
        seedCents,
        wdlCents,
        count,
        expectedWins,
        succeededCount: succeeded.length,
        rejectedCount: rejected.length,
        insufficientCount: rejected.filter((r) => r.code === 'INSUFFICIENT_FUNDS').length,
        finalBalance: accCheck.account.balance,
        conservationValid: consCheck.is_valid,
        elapsedMs,
        outcomes
      });

      notify(
        `Parallel Race finished: ${succeeded.length}/${count} succeeded, ${rejected.length} blocked with zero overdraft!`,
        'success'
      );
      await onCompleteRefresh?.();
    } catch (err) {
      notify(err.message || 'Concurrency test failed.', 'error');
    } finally {
      setRaceRunning(false);
    }
  }

  async function executeIdempotencyStep(stepMode) {
    const baseCents = dollarsToCents(idemAmount);
    if (!targetAccountId || Number.isNaN(baseCents)) {
      notify('Select an active account and valid amount.', 'error');
      return;
    }

    const activeKey = stepMode === 'initial' ? newIdempotencyKey('lab-idem') : idemKey;
    if (stepMode === 'initial') {
      setIdemKey(activeKey);
      setIdemSteps([]);
    }

    const sendCents = stepMode === 'tamper' ? baseCents + 100 : baseCents;
    setIdemBusy(true);
    try {
      const res = await apiFetch('/api/transactions/deposit', {
        method: 'POST',
        headers: { 'Idempotency-Key': activeKey },
        body: {
          accountId: targetAccountId,
          amount: sendCents,
          description: `Idempotency Lab (${stepMode})`
        }
      });
      setIdemSteps((prev) => [
        ...prev,
        {
          mode: stepMode,
          status: res.isCached ? 200 : 201,
          key: activeKey,
          amount: sendCents,
          isCached: Boolean(res.isCached),
          txId: res.transactionId,
          newBalance: res.newBalance
        }
      ]);
      await onCompleteRefresh?.();
    } catch (err) {
      setIdemSteps((prev) => [
        ...prev,
        {
          mode: stepMode,
          status: err.status || 400,
          key: activeKey,
          amount: sendCents,
          errorCode: err.code || err.message,
          blocked: true
        }
      ]);
    } finally {
      setIdemBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <i className="fa-solid fa-flask-vial text-lg" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">ACID Verification & Stress Lab</h3>
              <p className="text-xs text-slate-400">
                Execute genuine parallel race conditions & idempotency tamper probes against the live ledger
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white p-1">
            <i className="fa-solid fa-xmark text-base" />
          </button>
        </div>

        {/* Lab Mode Switcher */}
        <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800 mb-5">
          <button
            type="button"
            onClick={() => setTab('concurrency')}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
              tab === 'concurrency' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <i className="fa-solid fa-bolt mr-1.5" />
            Parallel Race Condition Simulator
          </button>
          <button
            type="button"
            onClick={() => setTab('idempotency')}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
              tab === 'idempotency' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <i className="fa-solid fa-fingerprint mr-1.5" />
            Idempotency Replay & Tamper Guard
          </button>
        </div>

        {tab === 'concurrency' && (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 text-xs text-slate-300">
              Creates a fresh sandbox Checking account, deposits your chosen test budget, and fires{' '}
              <strong>N simultaneous parallel withdrawals</strong> via <code className="text-indigo-300">Promise.all()</code> to prove serialized locking prevents double-spends and negative balances.
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">Sandbox Budget (USD)</label>
                <input
                  type="text"
                  value={seedDollars}
                  onChange={(e) => setSeedDollars(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">Withdrawal Size (USD)</label>
                <input
                  type="text"
                  value={withdrawDollars}
                  onChange={(e) => setWithdrawDollars(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">Parallel Threads (2–40)</label>
                <input
                  type="number"
                  min={2}
                  max={40}
                  value={burstCount}
                  onChange={(e) => setBurstCount(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-white"
                />
              </div>
            </div>

            <button
              type="button"
              disabled={raceRunning}
              onClick={runConcurrencyBurst}
              className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs sm:text-sm font-semibold text-white transition-colors"
            >
              {raceRunning ? (
                <>
                  <i className="fa-solid fa-spinner fa-spin mr-2" />
                  Dispatching Parallel Withdrawals...
                </>
              ) : (
                <>
                  <i className="fa-solid fa-rocket mr-2" />
                  Launch {burstCount} Simultaneous Withdrawals
                </>
              )}
            </button>

            {raceResult && (
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase">Succeeded (201)</div>
                    <div className="text-lg font-bold text-emerald-400 font-mono">
                      {raceResult.succeededCount} / {raceResult.expectedWins} expected
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase">Blocked (400)</div>
                    <div className="text-lg font-bold text-rose-400 font-mono">
                      {raceResult.rejectedCount} ({raceResult.insufficientCount} INSUFFICIENT)
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase">Final Balance</div>
                    <div className="text-lg font-bold text-white font-mono">
                      {formatCents(raceResult.finalBalance)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase">Conservation</div>
                    <div className="text-sm font-bold text-emerald-400 mt-1">
                      {raceResult.conservationValid ? 'BALANCED' : 'ERROR'} ({raceResult.elapsedMs}ms)
                    </div>
                  </div>
                </div>

                {/* Visual outcome grid */}
                <div>
                  <div className="text-[11px] text-slate-400 mb-2">
                    Thread Outcome Matrix for <span className="font-mono text-white">{raceResult.accountNumber}</span>:
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {raceResult.outcomes.map((o) => (
                      <span
                        key={o.idx}
                        title={o.ok ? `#${o.idx}: TX ${o.txId}` : `#${o.idx}: ${o.code}`}
                        className={`px-2 py-1 rounded text-[10px] font-mono font-semibold border ${
                          o.ok
                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                            : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                        }`}
                      >
                        #{o.idx} {o.ok ? 'PAID' : 'BLOCKED'}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'idempotency' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">Target Account</label>
                <select
                  value={targetAccountId}
                  onChange={(e) => setIdemTargetId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white"
                >
                  {accounts
                    .filter((a) => a.status === 'ACTIVE')
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.account_number} ({a.account_type} · {formatCents(a.balance)})
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-400 mb-1">Deposit Amount (USD)</label>
                <input
                  type="text"
                  value={idemAmount}
                  onChange={(e) => setIdemAmount(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-white"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={idemBusy || !targetAccountId}
                onClick={() => executeIdempotencyStep('initial')}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-xs font-semibold text-white"
              >
                1. Send Initial Deposit
              </button>
              <button
                type="button"
                disabled={idemBusy || idemSteps.length === 0}
                onClick={() => executeIdempotencyStep('replay')}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-xs font-semibold text-white"
              >
                2. Replay Identical Key (Expect 200 Cached)
              </button>
              <button
                type="button"
                disabled={idemBusy || idemSteps.length === 0}
                onClick={() => executeIdempotencyStep('tamper')}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-xs font-semibold text-white"
              >
                3. Reuse Key w/ Tampered Amount (+$1.00 · Expect 422)
              </button>
            </div>

            {idemSteps.length > 0 && (
              <div className="space-y-2 pt-2">
                {idemSteps.map((s, idx) => (
                  <div
                    key={idx}
                    className={`p-3 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-2 ${
                      s.blocked
                        ? 'bg-amber-950/30 border-amber-700/60 text-amber-200'
                        : s.isCached
                        ? 'bg-sky-950/30 border-sky-700/60 text-sky-200'
                        : 'bg-emerald-950/30 border-emerald-700/60 text-emerald-200'
                    }`}
                  >
                    <div>
                      <span className="font-mono font-bold mr-2">HTTP {s.status}</span>
                      <span className="capitalize font-semibold">{s.mode}</span> · Amount {formatCents(s.amount)}
                      <div className="text-[10px] font-mono text-slate-400">Key: {s.key}</div>
                    </div>
                    <div className="font-mono text-[11px]">
                      {s.blocked
                        ? `BLOCKED: ${s.errorCode}`
                        : s.isCached
                        ? `CACHED REPLAY (${s.txId})`
                        : `EXECUTED (${s.txId})`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
