import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  apiFetch,
  clearStoredToken,
  connectEventStream,
  formatDateTime,
  getStoredToken,
  setUnauthorizedHandler
} from './api/client.js';
import ToastContainer from './components/ToastContainer.jsx';
import ChangePasswordModal from './components/ChangePasswordModal.jsx';
import TransactionXRayModal from './components/TransactionXRayModal.jsx';
import ProofLabModal from './components/ProofLabModal.jsx';
import CommandPaletteModal from './components/CommandPaletteModal.jsx';
import OpenApiModal from './components/OpenApiModal.jsx';
import AuthPage from './pages/AuthPage.jsx';
import HolderDashboard from './pages/HolderDashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import AuditorDashboard from './pages/AuditorDashboard.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [toasts, setToasts] = useState([]);
  const [adminView, setAdminView] = useState('admin');
  const [masked, setMasked] = useState(false);

  // Modals & Interactive Inspectors
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [xrayTxId, setXrayTxId] = useState('');
  const [labState, setLabState] = useState({ open: false, accounts: [] });
  const [showPalette, setShowPalette] = useState(false);
  const [showOpenApi, setShowOpenApi] = useState(false);

  // Real-time SSE Feed State
  const [sseStatus, setSseStatus] = useState('disconnected');
  const [liveEvents, setLiveEvents] = useState([]);
  const [showFeedDrawer, setShowFeedDrawer] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);

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

  // Connect authenticated SSE live event stream once signed in
  useEffect(() => {
    if (!user) {
      setSseStatus('disconnected');
      setLiveEvents([]);
      return undefined;
    }

    const disconnect = connectEventStream({
      onStatusChange: (status) => setSseStatus(status),
      onEvent: (evt) => {
        setLiveEvents((prev) => [evt, ...prev].slice(0, 30));
        if (evt.type === 'ledger:tx' || evt.type === 'account:status') {
          setRefreshSignal((s) => s + 1);
        } else if (evt.type === 'audit:event' && (user.role === 'ADMIN' || user.role === 'AUDITOR')) {
          setRefreshSignal((s) => s + 1);
        }
      }
    });

    return () => disconnect();
  }, [user]);

  // Global Ctrl+K / Cmd+K Command Palette Shortcut
  useEffect(() => {
    if (!user) return undefined;
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [user]);

  const handleLogout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', skipAuthRedirect: true });
    } catch {
      // Ignore expired tokens on sign-out
    } finally {
      clearStoredToken();
      setUser(null);
      notify('Signed out and server session token revoked.', 'info');
    }
  }, [notify]);

  const commands = useMemo(() => {
    if (!user) return [];
    const list = [
      {
        id: 'mask',
        label: masked ? 'Reveal Financial Balances' : 'Mask Sensitive Dollar Amounts',
        subtitle: 'Toggle privacy blur mode across cards, tables & charts',
        icon: masked ? 'fa-eye' : 'fa-eye-slash',
        category: 'Privacy',
        run: () => setMasked((m) => !m)
      },
      {
        id: 'feed',
        label: 'Toggle Live SSE Event Stream Drawer',
        subtitle: `Stream status: ${sseStatus} (${liveEvents.length} recent events)`,
        icon: 'fa-tower-broadcast',
        category: 'Realtime',
        run: () => setShowFeedDrawer((f) => !f)
      },
      {
        id: 'refresh',
        label: 'Force Sync All Dashboard Widgets',
        subtitle: 'Pull fresh accounts, statements, metrics & conservation checks',
        icon: 'fa-rotate',
        category: 'Sync',
        run: () => setRefreshSignal((s) => s + 1)
      },
      {
        id: 'openapi',
        label: 'Explore Live OpenAPI 3.0 Spec',
        subtitle: 'Inspect REST routes, auth headers & schemas from /api/openapi.json',
        icon: 'fa-code',
        category: 'Docs',
        run: () => setShowOpenApi(true)
      },
      {
        id: 'password',
        label: 'Rotate / Change Account Password',
        subtitle: 'Updates PBKDF2-SHA512 credentials & revokes previous JWT',
        icon: 'fa-key',
        category: 'Security',
        run: () => setShowPasswordModal(true)
      },
      {
        id: 'logout',
        label: 'Sign Out (Revoke Session Token)',
        subtitle: 'Adds JWT jti to server-side revoked_tokens table',
        icon: 'fa-right-from-bracket',
        category: 'Session',
        run: handleLogout
      }
    ];

    if (user.role === 'ACCOUNT_HOLDER') {
      list.unshift({
        id: 'lab',
        label: 'Open ACID Concurrency & Idempotency Lab',
        subtitle: 'Fire live parallel bursts & tamper tests against the double-entry engine',
        icon: 'fa-flask-vial',
        category: 'Verify',
        run: async () => {
          try {
            const res = await apiFetch('/api/accounts');
            setLabState({ open: true, accounts: res.accounts || [] });
          } catch (_) {
            setLabState({ open: true, accounts: [] });
          }
        }
      });
    }

    if (user.role === 'ADMIN') {
      list.unshift(
        {
          id: 'view-admin',
          label: 'Switch to Admin Operations Console',
          subtitle: 'Manage user onboarding, account freezes & runtime telemetry',
          icon: 'fa-users-gear',
          category: 'Navigate',
          run: () => setAdminView('admin')
        },
        {
          id: 'view-audit',
          label: 'Switch to Auditor & Hash-Chain Compliance View',
          subtitle: 'Inspect SHA-256 audit chain, CSV exports & double-entry ledger lines',
          icon: 'fa-scroll',
          category: 'Navigate',
          run: () => setAdminView('audit')
        }
      );
    }

    return list;
  }, [user, masked, sseStatus, liveEvents.length, handleLogout]);

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
            <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
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
                <div className="hidden md:flex bg-slate-950 p-1 rounded-xl border border-slate-800">
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

              <div className="flex items-center gap-2">
                {/* Command Palette Pill */}
                <button
                  type="button"
                  onClick={() => setShowPalette(true)}
                  className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-600 text-xs text-slate-400 hover:text-white transition-colors"
                  title="Open Command Palette (Ctrl+K)"
                >
                  <i className="fa-solid fa-terminal text-[11px] text-emerald-400" />
                  <span>Commands</span>
                  <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 font-mono text-slate-300">
                    Ctrl+K
                  </kbd>
                </button>

                {/* Real-time SSE Pulse Indicator */}
                <button
                  type="button"
                  onClick={() => setShowFeedDrawer((f) => !f)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-600 text-xs transition-colors"
                  title="Live Server-Sent Events Stream"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      sseStatus === 'connected'
                        ? 'bg-emerald-400 animate-pulse'
                        : sseStatus === 'reconnecting'
                        ? 'bg-amber-400 animate-pulse'
                        : 'bg-slate-500'
                    }`}
                  />
                  <span className="hidden lg:inline font-mono text-[11px] text-slate-300">
                    LIVE ({liveEvents.length})
                  </span>
                </button>

                {/* Privacy Balance Mask Toggle */}
                <button
                  type="button"
                  onClick={() => setMasked((m) => !m)}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                    masked
                      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                      : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-600'
                  }`}
                  title={masked ? 'Show Dollar Amounts' : 'Mask Balances'}
                >
                  <i className={`fa-solid ${masked ? 'fa-eye-slash' : 'fa-eye'}`} />
                </button>

                <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs">
                  <span className="text-slate-300 font-medium">{user.username}</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-mono text-[10px]">
                    {user.role}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowPasswordModal(true)}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 text-xs font-medium text-slate-200 transition-colors"
                  title="Change Password"
                >
                  <i className="fa-solid fa-key" />
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

            {/* Expandable Live SSE Activity Ticker */}
            {showFeedDrawer && (
              <div className="border-t border-slate-800 bg-slate-950/95">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
                  <div className="flex items-center justify-between mb-2 text-xs">
                    <span className="font-semibold text-emerald-300 flex items-center gap-2">
                      <i className="fa-solid fa-tower-broadcast" />
                      Real-Time SSE Event Stream ({sseStatus})
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowFeedDrawer(false)}
                      className="text-slate-400 hover:text-white text-xs"
                    >
                      Close
                    </button>
                  </div>
                  {liveEvents.length === 0 ? (
                    <div className="text-xs text-slate-500">Listening for real-time ledger & audit events...</div>
                  ) : (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {liveEvents.slice(0, 8).map((ev, i) => (
                        <div
                          key={`${ev.timestamp}-${i}`}
                          className="shrink-0 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-[11px] font-mono max-w-xs"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sky-400 font-semibold">{ev.type}</span>
                            <span className="text-slate-500 text-[10px]">
                              {formatDateTime(ev.timestamp)}
                            </span>
                          </div>
                          <div className="text-slate-300 truncate mt-0.5">
                            {ev.data?.action || ev.data?.type || ev.data?.status || 'connected'}
                            {ev.data?.transactionId ? ` · ${ev.data.transactionId.slice(0, 12)}` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </header>

          {/* Role-Isolated Main Workspace */}
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
            {user.role === 'ACCOUNT_HOLDER' && (
              <HolderDashboard
                user={user}
                notify={notify}
                masked={masked}
                refreshSignal={refreshSignal}
                onInspectTx={(txId) => setXrayTxId(txId)}
                onOpenLab={(accs) => setLabState({ open: true, accounts: accs })}
              />
            )}
            {user.role === 'AUDITOR' && (
              <AuditorDashboard
                notify={notify}
                masked={masked}
                refreshSignal={refreshSignal}
                onInspectTx={(txId) => setXrayTxId(txId)}
              />
            )}
            {user.role === 'ADMIN' &&
              (adminView === 'audit' ? (
                <AuditorDashboard
                  notify={notify}
                  masked={masked}
                  refreshSignal={refreshSignal}
                  onInspectTx={(txId) => setXrayTxId(txId)}
                />
              ) : (
                <AdminDashboard
                  user={user}
                  notify={notify}
                  masked={masked}
                  refreshSignal={refreshSignal}
                  onOpenApi={() => setShowOpenApi(true)}
                />
              ))}
          </main>

          <ChangePasswordModal
            isOpen={showPasswordModal}
            onClose={() => setShowPasswordModal(false)}
            notify={notify}
          />
          <TransactionXRayModal
            transactionId={xrayTxId}
            masked={masked}
            onClose={() => setXrayTxId('')}
          />
          <ProofLabModal
            isOpen={labState.open}
            onClose={() => setLabState({ open: false, accounts: [] })}
            accounts={labState.accounts}
            onCompleteRefresh={() => setRefreshSignal((s) => s + 1)}
            notify={notify}
          />
          <CommandPaletteModal
            isOpen={showPalette}
            onClose={() => setShowPalette(false)}
            commands={commands}
          />
          <OpenApiModal
            isOpen={showOpenApi}
            onClose={() => setShowOpenApi(false)}
          />
        </div>
      )}
    </>
  );
}
