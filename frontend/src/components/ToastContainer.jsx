import React from 'react';

export default function ToastContainer({ toasts, onDismiss }) {
  if (!toasts || toasts.length === 0) return null;

  const styles = {
    success: 'bg-emerald-950/95 border-emerald-700/80 text-emerald-100',
    error: 'bg-rose-950/95 border-rose-700/80 text-rose-100',
    info: 'bg-slate-900/95 border-slate-700 text-slate-100'
  };

  const icons = {
    success: 'fa-circle-check text-emerald-400',
    error: 'fa-triangle-exclamation text-rose-400',
    info: 'fa-circle-info text-sky-400'
  };

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border shadow-2xl backdrop-blur ${styles[t.type] || styles.info}`}
        >
          <i className={`fa-solid ${icons[t.type] || icons.info} mt-0.5 text-sm`} />
          <div className="flex-1 text-xs sm:text-sm leading-snug">{t.message}</div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="text-slate-400 hover:text-white text-xs p-0.5"
            aria-label="Dismiss notification"
          >
            <i className="fa-solid fa-xmark" />
          </button>
        </div>
      ))}
    </div>
  );
}
