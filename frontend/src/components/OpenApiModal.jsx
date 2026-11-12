import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';

export default function OpenApiModal({ isOpen, onClose }) {
  const [spec, setSpec] = useState(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || spec) return;
    setLoading(true);
    apiFetch('/api/openapi.json', { skipAuthRedirect: true })
      .then((res) => setSpec(res))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen, spec]);

  if (!isOpen) return null;

  const entries = Object.entries(spec?.paths || {}).filter(([p]) =>
    !filter.trim() || p.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <i className="fa-solid fa-code" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">
                {spec?.info?.title || 'LedgerLine OpenAPI 3.0 Spec'}
              </h3>
              <p className="text-xs text-slate-400 font-mono">
                OpenAPI {spec?.openapi || '3.0.3'} · Version {spec?.info?.version || '1.1.0'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/api/openapi.json"
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
            >
              Raw JSON
            </a>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white p-1">
              <i className="fa-solid fa-xmark text-base" />
            </button>
          </div>
        </div>

        <input
          type="text"
          placeholder="Filter endpoints (e.g. /audit, /transactions, /events)..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-white mb-4"
        />

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {loading ? (
            <div className="py-10 text-center text-xs text-slate-400">Loading live OpenAPI spec...</div>
          ) : (
            entries.map(([routePath, methods]) =>
              Object.entries(methods).map(([httpMethod, meta]) => (
                <div
                  key={`${httpMethod}-${routePath}`}
                  className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                        httpMethod === 'get'
                          ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                          : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      }`}
                    >
                      {httpMethod}
                    </span>
                    <span className="font-mono text-white font-semibold">/api{routePath}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-400">
                    <span>{meta.summary}</span>
                    {meta.security && (
                      <i className="fa-solid fa-lock text-amber-400 text-[10px]" title="Bearer JWT Required" />
                    )}
                  </div>
                </div>
              ))
            )
          )}
        </div>
      </div>
    </div>
  );
}
