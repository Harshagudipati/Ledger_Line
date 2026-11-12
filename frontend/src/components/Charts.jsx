import React, { useState } from 'react';
import { formatCents, formatDateTime } from '../api/client.js';

export function BalanceTrajectoryChart({ entries = [], masked = false, onSelectTx }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  if (!entries || entries.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <i className="fa-solid fa-chart-area text-emerald-400" />
            Balance Trajectory
          </h3>
          <span className="text-[11px] text-slate-500">Zero-drift integer ledger curve</span>
        </div>
        <div className="h-32 flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
          Execute a deposit or transfer to plot interactive balance history.
        </div>
      </div>
    );
  }

  const points = entries.slice(-24);
  const values = points.map((p) => Number(p.running_balance || 0));
  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 100);
  const span = Math.max(maxVal - minVal, 100);

  const width = 640;
  const height = 160;
  const padX = 16;
  const padY = 18;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const coords = points.map((p, idx) => {
    const x = points.length === 1 ? padX + plotW / 2 : padX + (idx / (points.length - 1)) * plotW;
    const norm = (Number(p.running_balance || 0) - minVal) / span;
    const y = padY + plotH - norm * plotH;
    return { x, y, entry: p };
  });

  const linePath = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(height - padY).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(height - padY).toFixed(1)} Z`;

  const active = hoverIdx !== null ? coords[hoverIdx] : coords[coords.length - 1];

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <i className="fa-solid fa-chart-area text-emerald-400" />
            Balance Trajectory (Last {points.length} Entries)
          </h3>
          <p className="text-[11px] text-slate-400">
            Hover points to inspect deltas · Click any point to open Double-Entry X-Ray
          </p>
        </div>

        {active && (
          <div className="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs flex items-center gap-3">
            <span className="text-slate-400 font-mono text-[10px]">
              {active.entry.transaction_type}
            </span>
            <span
              className={`font-mono font-semibold ${
                active.entry.direction === 'CREDIT' ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {active.entry.direction === 'CREDIT' ? '+' : '-'}
              {formatCents(active.entry.amount, masked)}
            </span>
            <span className="text-white font-bold tabular-nums">
              → {formatCents(active.entry.running_balance, masked)}
            </span>
          </div>
        )}
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40 overflow-visible select-none">
          <defs>
            <linearGradient id="ledgerAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Horizontal Grid Lines */}
          {[0, 0.5, 1].map((g) => {
            const gy = padY + g * plotH;
            return (
              <line
                key={g}
                x1={padX}
                y1={gy}
                x2={width - padX}
                y2={gy}
                stroke="#1e293b"
                strokeDasharray="3 3"
              />
            );
          })}

          {points.length > 1 && <path d={areaPath} fill="url(#ledgerAreaGrad)" />}
          {points.length > 1 && (
            <path d={linePath} fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          )}

          {coords.map((c, idx) => {
            const isHovered = hoverIdx === idx;
            const isCredit = c.entry.direction === 'CREDIT';
            return (
              <g
                key={c.entry.entry_id}
                className="cursor-pointer"
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx(null)}
                onClick={() => onSelectTx?.(c.entry.transaction_id)}
              >
                <circle cx={c.x} cy={c.y} r={10} fill="transparent" />
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={isHovered ? 5.5 : 3.5}
                  fill={isCredit ? '#10b981' : '#f43f5e'}
                  stroke="#0f172a"
                  strokeWidth="2"
                />
              </g>
            );
          })}
        </svg>
        {active && (
          <div className="flex justify-between text-[10px] text-slate-500 font-mono mt-1 px-1">
            <span>{formatDateTime(points[0]?.created_at)}</span>
            <span>{active.entry.description || active.entry.transaction_id}</span>
            <span>{formatDateTime(points[points.length - 1]?.created_at)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TelemetryBreakdownCard({ metrics }) {
  if (!metrics) return null;

  const total = Math.max(metrics.totalRequests || 0, 1);
  const b2 = metrics.statusBuckets?.['2xx'] || 0;
  const b4 = metrics.statusBuckets?.['4xx'] || 0;
  const b5 = metrics.statusBuckets?.['5xx'] || 0;

  const pct2 = Math.round((b2 / total) * 100);
  const pct4 = Math.round((b4 / total) * 100);
  const pct5 = Math.max(0, 100 - pct2 - pct4);

  const recent = metrics.recentRequests || [];
  const maxLat = Math.max(...recent.map((r) => r.durationMs || 0), 5);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            HTTP Response Distribution
          </h3>
          <span className="text-xs font-mono text-slate-300">
            Memory RSS: {metrics.memoryRssMb} MB · Up {metrics.uptimeSeconds}s
          </span>
        </div>

        <div className="h-3 rounded-full overflow-hidden bg-slate-800 flex my-3">
          {b2 > 0 && <div style={{ width: `${pct2}%` }} className="bg-emerald-500 transition-all" title={`2xx: ${b2}`} />}
          {b4 > 0 && <div style={{ width: `${pct4}%` }} className="bg-amber-500 transition-all" title={`4xx: ${b4}`} />}
          {b5 > 0 && <div style={{ width: `${pct5}%` }} className="bg-rose-500 transition-all" title={`5xx: ${b5}`} />}
        </div>

        <div className="flex flex-wrap gap-4 text-xs">
          <span className="flex items-center gap-1.5 text-emerald-300">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            2xx OK: <strong>{b2}</strong>
          </span>
          <span className="flex items-center gap-1.5 text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            4xx Guarded: <strong>{b4}</strong>
          </span>
          <span className="flex items-center gap-1.5 text-rose-300">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            5xx Errors: <strong>{b5}</strong>
          </span>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Recent API Latency Pulse (Last {recent.length} Calls)
          </h3>
          <span className="text-xs font-mono text-sky-400">{metrics.avgLatencyMs} ms avg</span>
        </div>

        <div className="h-14 flex items-end gap-1.5 px-2 py-2 rounded-xl bg-slate-950 border border-slate-800">
          {recent.length === 0 ? (
            <span className="text-[11px] text-slate-500 m-auto">No recent requests yet.</span>
          ) : (
            recent.map((r, i) => {
              const barPct = Math.max(12, Math.min(100, Math.round((r.durationMs / maxLat) * 100)));
              const color =
                r.statusCode >= 500
                  ? 'bg-rose-500'
                  : r.statusCode >= 400
                  ? 'bg-amber-400'
                  : 'bg-sky-400';
              return (
                <div
                  key={`${r.requestId}-${i}`}
                  style={{ height: `${barPct}%` }}
                  className={`flex-1 rounded-t ${color} opacity-85 hover:opacity-100 transition-all`}
                  title={`${r.method} ${r.path} -> ${r.statusCode} (${r.durationMs}ms)`}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
