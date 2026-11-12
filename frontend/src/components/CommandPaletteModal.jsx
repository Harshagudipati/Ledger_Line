import React, { useEffect, useState } from 'react';

export default function CommandPaletteModal({ isOpen, onClose, commands = [] }) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (isOpen) setQuery('');
  }, [isOpen]);

  if (!isOpen) return null;

  const filtered = commands.filter((c) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      c.label.toLowerCase().includes(q) ||
      (c.subtitle || '').toLowerCase().includes(q) ||
      (c.category || '').toLowerCase().includes(q)
    );
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center pt-20 p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800">
          <i className="fa-solid fa-terminal text-emerald-400 text-sm" />
          <input
            type="text"
            autoFocus
            placeholder="Type a command or jump to action..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && filtered[0]) {
                filtered[0].run();
                onClose();
              }
            }}
            className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">ESC</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto divide-y divide-slate-800/60">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">No matching commands.</div>
          ) : (
            filtered.map((cmd) => (
              <button
                key={cmd.id}
                type="button"
                onClick={() => {
                  cmd.run();
                  onClose();
                }}
                className="w-full px-4 py-3 text-left hover:bg-slate-800/70 flex items-center justify-between gap-3 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center text-emerald-400 text-xs shrink-0">
                    <i className={`fa-solid ${cmd.icon || 'fa-bolt'}`} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white truncate">{cmd.label}</div>
                    {cmd.subtitle && (
                      <div className="text-[11px] text-slate-400 truncate">{cmd.subtitle}</div>
                    )}
                  </div>
                </div>
                {cmd.category && (
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono shrink-0">
                    {cmd.category}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
