import React, { useCallback, useEffect, useState } from 'react';
import {
  apiFetch,
  clearStoredToken,
  getStoredToken,
  setUnauthorizedHandler
} from './api/client.js';
import ToastContainer from './components/ToastContainer.jsx';
import ChangePasswordModal from './components/ChangePasswordModal.jsx';
import AuthPage from './pages/AuthPage.jsx';
import HolderDashboard from './pages/HolderDashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import AuditorDashboard from './pages/AuditorDashboard.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [toasts, setToasts] = useState([]);
  const [adminView, setAdminView] = useState('admin'); // 'admin' | 'audit'
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((message, type = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler((code) => {
      clearStoredToken();
      setUser(null);
      notify(
        code === 'TOKEN_REVOKED'
          ? 'Session has been revoked. Please sign in again.'
          : 'Your session expired. Please sign in again.',
        'info'
      );
    });
  }, [notify]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const token = getStoredToken();
      if (!token) {
        if (mounted) setBootLoading(false);
        return;
      }
      try {
        const res = await apiFetch('/api/auth/me', { skipAuthRedirect: true });
        if (mounted) setUser(res.user);
      } catch {
        clearStoredToken();
        if (mounted) setUser(null);
      } finally {
        if (mounted) setBootLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function handleLogout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', skipAuthRedirect: true });
    } catch {
      // Clear local session even if token already expired
    } finally {
      clearStoredToken();
      setUser(null);
      notify('Signed out and server session token revoked.', 'info');
    }
  }

  if (bootLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-300 text-sm">
        <i className="fa-solid fa-spinner fa-spin text-emerald-400 mr-2.5 text-lg" />
        Verifying LedgerLine session...
      </div>
    );
  }

  return (
    <>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {!user ? (
        <AuthPage
          onAuthenticated={(u) => {
            setUser(u);
            setAdminView('admin');
          }}
          notify={notify}
        />
      ) : (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
          {/* Top Sticky Role Header */}
          <header className="sticky top-0 z-30 bg-slate-900/90 backdrop-blur border-b border-slate-800">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <i className="fa-solid fa-vault" />
                </div>
                <div>
                  <div className="text-sm font-bold text-white leading-none">LedgerLine</div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">BalanceVault Core</div>
                </div>
              </div>

              {user.role === 'ADMIN' && (
                <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setAdminView('admin')}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      adminView === 'admin'
                        ? 'bg-emerald-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Admin Console
                  </button>
                  <button
                    type="button"
                    onClick={() => setAdminView('audit')}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                      adminView === 'audit'
                        ? 'bg-emerald-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Audit & Ledger
                  </button>
                </div>
              )}

              <div className="flex items-center gap-2.5">
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs">
                  <span className="text-slate-300 font-medium">{user.username}</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[10px]">
                    {user.role}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowPasswordModal(true)}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 text-xs font-medium text-slate-200 transition-colors"
                  title="Change Password"
                >
                  <i className="fa-solid fa-key sm:mr-1.5" />
                  <span className="hidden sm:inline">Password</span>
                </button>

                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-3 py-1.5 rounded-lg bg-rose-950/60 hover:bg-rose-900/70 border border-rose-800/70 text-xs font-medium text-rose-200 transition-colors"
                >
                  <i className="fa-solid fa-right-from-bracket sm:mr-1.5" />
                  <span className="hidden sm:inline">Sign Out</span>
                </button>
              </div>
            </div>
          </header>

          {/* Role-Isolated Main Workspace */}
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
            {user.role === 'ACCOUNT_HOLDER' && (
              <HolderDashboard user={user} notify={notify} />
            )}
            {user.role === 'AUDITOR' && (
              <AuditorDashboard notify={notify} />
            )}
            {user.role === 'ADMIN' && (
              adminView === 'audit'
                ? <AuditorDashboard notify={notify} />
                : <AdminDashboard user={user} notify={notify} />
            )}
          </main>

          <ChangePasswordModal
            isOpen={showPasswordModal}
            onClose={() => setShowPasswordModal(false)}
            notify={notify}
          />
        </div>
      )}
    </>
  );
}
