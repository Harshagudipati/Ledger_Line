import React, { useEffect, useState } from 'react';
import { apiFetch, formatCents, formatDateTime } from '../api/client.js';

export default function TransactionXRayModal({ transactionId, masked = false, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);

  useEffect(() => {
    if (!transactionId) return;
    let mounted = true;
    setLoading(true);
    setError('');
    setShowRawJson(false);

    (async () => {
      try {
        const res = await apiFetch(`/api/transactions/${encodeURIComponent(transactionId)}`);
        if (mounted) setData(res);
      } catch (err) {
        if (mounted) setError(err.message || 'Could not load transaction breakdown.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [transactionId]);

  if (!transactionId) return null;

  const debitLegs = data?.entries?.filter((e) => e.direction === 'DEBIT') || [];
  const creditLegs = data?.entries?.filter((e) => e.direction === 'CREDIT') || [];

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <i className="fa-solid fa-magnifying-glass-chart" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Double-Entry Transaction X-Ray</h3>
              <p className="text-[11px] font-mono text-slate-400">{transactionId}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1"
            aria-label="Close X-Ray"
          >
            <i className="fa-solid fa-xmark text-base" />
          </button>
        </div>

        {loading && (
          <div className="py-12 text-center text-xs text-slate-400">
            <i className="fa-solid fa-spinner fa-spin text-sky-400 mr-2" />
            Inspecting double-entry ledger legs...
          </div>
        )}

        {error && (
          <div className="p-4 rounded-xl bg-rose-950/50 border border-rose-800 text-rose-200 text-xs">
            {error}
          </div>
        )}

        {!loading && data && (
          <div className="space-y-5">
            {/* Top Summary Banner */}
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <div className="text-slate-500 text-[10px] uppercase">Type</div>
                <div className="font-mono font-bold text-white mt-0.5">{data.transaction.type}</div>
              </div>
              <div>
                <div className="text-slate-500 text-[10px] uppercase">Amount</div>
                <div className="font-mono font-bold text-emerald-400 mt-0.5">
                  {formatCents(data.transaction.amount, masked)}
                </div>
              </div>
              <div>
                <div className="text-slate-500 text-[10px] uppercase">Zero-Sum Proof</div>
                <div className="font-semibold text-emerald-400 mt-0.5">
                  {data.proof.is_zero_sum_balanced ? 'DEBITS == CREDITS' : 'IMBALANCED'}
                </div>
              </div>
              <div>
                <div className="text-slate-500 text-[10px] uppercase">Timestamp</div>
                <div className="text-slate-300 mt-0.5">{formatDateTime(data.transaction.created_at)}</div>
              </div>
            </div>

            {/* Visual Balanced Flow: Debit Leg(s) -> Credit Leg(s) */}
            <div className="grid grid-cols-1 md:grid-cols-11 gap-3 items-center">
              <div className="md:col-span-5 space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-rose-300">
                  DEBIT Source Leg(s)
                </div>
                {debitLegs.map((leg) => (
                  <div
                    key={leg.id}
                    className="p-3.5 rounded-xl bg-rose-950/25 border border-rose-800/50 text-xs"
                  >
                    <div className="flex justify-between font-mono font-semibold text-white">
                      <span>{leg.account_number}</span>
                      <span className="text-rose-300">-{formatCents(leg.amount, masked)}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {leg.owner_username} · {leg.account_type}
                    </div>
                  </div>
                ))}
              </div>

              <div className="md:col-span-1 flex justify-center text-emerald-400 text-lg">
                <i className="fa-solid fa-arrow-right hidden md:inline" />
                <i className="fa-solid fa-arrow-down md:hidden" />
              </div>

              <div className="md:col-span-5 space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
                  CREDIT Destination Leg(s)
                </div>
                {creditLegs.map((leg) => (
                  <div
                    key={leg.id}
                    className="p-3.5 rounded-xl bg-emerald-950/25 border border-emerald-800/50 text-xs"
                  >
                    <div className="flex justify-between font-mono font-semibold text-white">
                      <span>{leg.account_number}</span>
                      <span className="text-emerald-300">+{formatCents(leg.amount, masked)}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {leg.owner_username} · {leg.account_type}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Idempotency Fingerprint Metadata */}
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-xs">
              <div className="text-[11px] font-semibold text-slate-300 flex items-center gap-2">
                <i className="fa-solid fa-fingerprint text-sky-400" />
                Idempotency & Audit Metadata
              </div>
              <div className="grid sm:grid-cols-2 gap-2 font-mono text-[11px]">
                <div className="truncate text-slate-400">
                  Key: <span className="text-sky-300">{data.transaction.idempotency_key}</span>
                </div>
                <div className="truncate text-slate-400">
                  Actor: <span className="text-slate-200">{data.transaction.created_by_username}</span>
                </div>
              </div>
              {data.idempotency?.request_params_hash && (
                <div className="font-mono text-[10px] text-slate-500 break-all">
                  SHA-256 Params Hash: {data.idempotency.request_params_hash}
                </div>
              )}
              <div className="text-slate-300 text-xs pt-1">
                Memo: <span className="text-white">{data.transaction.description || '—'}</span>
              </div>
            </div>

            {/* Raw JSON Inspection Toggle */}
            <div>
              <button
                type="button"
                onClick={() => setShowRawJson((v) => !v)}
                className="text-xs text-sky-400 hover:text-sky-300 font-mono"
              >
                <i className={`fa-solid fa-chevron-${showRawJson ? 'down' : 'right'} mr-1.5`} />
                {showRawJson ? 'Hide Raw Ledger Proof JSON' : 'Inspect Raw Ledger Proof JSON'}
              </button>
              {showRawJson && (
                <pre className="mt-2 p-3 rounded-xl bg-slate-950 border border-slate-800 text-[10px] font-mono text-slate-300 overflow-x-auto max-h-48">
                  {JSON.stringify(data, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
