import React, { useEffect, useState } from 'react';
import { apiFetch, setStoredToken } from '../api/client.js';

export default function AuthPage({ onAuthenticated, notify }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'bootstrap'
  const [checkingBootstrap, setCheckingBootstrap] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorBanner, setErrorBanner] = useState('');
  const [successBanner, setSuccessBanner] = useState('');

  // Login fields
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Register fields (FR-6: strictly ACCOUNT_HOLDER)
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');

  // Bootstrap Admin fields (FR-4)
  const [bootUsername, setBootUsername] = useState('admin');
  const [bootEmail, setBootEmail] = useState('');
  const [bootPassword, setBootPassword] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await apiFetch('/api/auth/bootstrap-status', { skipAuthRedirect: true });
        if (mounted && res?.needsBootstrap) {
          setMode('bootstrap');
        }
      } catch {
        // Default to login tab if status check fails
      } finally {
        if (mounted) setCheckingBootstrap(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setErrorBanner('');
    setSuccessBanner('');
    setSubmitting(true);
    try {
      const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { username: loginUsername.trim(), password: loginPassword },
        skipAuthRedirect: true
      });
      setStoredToken(data.token);
      notify(`Signed in as ${data.user.username} (${data.user.role})`, 'success');
      onAuthenticated(data.user);
    } catch (err) {
      setErrorBanner(err.message || 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setErrorBanner('');
    setSuccessBanner('');
    setSubmitting(true);
    try {
      const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: {
          username: regUsername.trim(),
          email: regEmail.trim(),
          password: regPassword
        },
        skipAuthRedirect: true
      });
      setSuccessBanner(
        data.message ||
          `Account holder '${regUsername.trim()}' created in PENDING_APPROVAL. An administrator must activate it before sign-in.`
      );
      setRegUsername('');
      setRegEmail('');
      setRegPassword('');
      setMode('login');
      notify('Registration submitted. Awaiting Administrator approval.', 'info');
    } catch (err) {
      setErrorBanner(err.message || 'Registration failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBootstrap(e) {
    e.preventDefault();
    setErrorBanner('');
    setSuccessBanner('');
    setSubmitting(true);
    try {
      await apiFetch('/api/auth/bootstrap', {
        method: 'POST',
        body: {
          username: bootUsername.trim(),
          email: bootEmail.trim(),
          password: bootPassword
        },
        skipAuthRedirect: true
      });
      setSuccessBanner(`Root Administrator '${bootUsername.trim()}' created cleanly. Please sign in below.`);
      setLoginUsername(bootUsername.trim());
      setBootPassword('');
      setMode('login');
      notify('System bootstrapped! Sign in with your new Admin credentials.', 'success');
    } catch (err) {
      setErrorBanner(err.message || 'Bootstrap initialization failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
      <div className="w-full max-w-5xl grid lg:grid-cols-5 gap-6 items-stretch">
        {/* Left Architecture & Security Overview */}
        <div className="lg:col-span-2 bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <i className="fa-solid fa-vault text-lg" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-white">LedgerLine</h1>
                <p className="text-xs text-slate-400 font-mono">BalanceVault Core v1.1</p>
              </div>
            </div>

            <h2 className="text-lg font-semibold text-white mb-2">
              Provably Correct Double-Entry Financial Ledger
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed mb-6">
              Authenticate to access your role-isolated financial workspace. Every monetary movement enforces integer-cent precision, serialized ACID locks, idempotent replay protection, and append-only compliance auditing.
            </p>

            <div className="space-y-3 text-xs text-slate-300">
              <div className="flex items-start gap-2.5">
                <i className="fa-solid fa-shield-halved text-emerald-400 mt-0.5" />
                <span><strong className="text-white">Strict RBAC & Session Revocation:</strong> JWT tokens carry unique <code className="text-emerald-300">jti</code> identifiers revoked server-side on logout.</span>
              </div>
              <div className="flex items-start gap-2.5">
                <i className="fa-solid fa-scale-balanced text-emerald-400 mt-0.5" />
                <span><strong className="text-white">Zero-Sum Double Entry:</strong> Clearing Vault + Customer Liquidity invariants stay balanced at every transaction.</span>
              </div>
              <div className="flex items-start gap-2.5">
                <i className="fa-solid fa-fingerprint text-emerald-400 mt-0.5" />
                <span><strong className="text-white">Brute-Force Lockout & Rate Limiting:</strong> Automated lockout after repeated invalid logins and sliding-window API throttling.</span>
              </div>
            </div>
          </div>

          <div className="mt-8 pt-5 border-t border-slate-800 text-[11px] text-slate-500 flex items-center justify-between">
            <span>Demo credentials appear in startup logs & <code className="text-slate-400">.env</code></span>
            <span className="text-emerald-400 font-mono">ACID Verified</span>
          </div>
        </div>

        {/* Right Auth Panel */}
        <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl flex flex-col justify-center">
          {checkingBootstrap ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              <i className="fa-solid fa-spinner fa-spin mr-2 text-emerald-400" />
              Checking environment security status...
            </div>
          ) : (
            <>
              {mode !== 'bootstrap' && (
                <div className="flex border-b border-slate-800 mb-6">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('login');
                      setErrorBanner('');
                    }}
                    className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-colors ${
                      mode === 'login'
                        ? 'border-emerald-500 text-emerald-400'
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <i className="fa-solid fa-right-to-bracket mr-2" />
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setErrorBanner('');
                    }}
                    className={`pb-3 px-4 text-sm font-semibold border-b-2 transition-colors ${
                      mode === 'register'
                        ? 'border-emerald-500 text-emerald-400'
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <i className="fa-solid fa-user-plus mr-2" />
                    Open Holder Account
                  </button>
                </div>
              )}

              {errorBanner && (
                <div className="mb-4 px-4 py-3 rounded-xl bg-rose-950/60 border border-rose-800 text-rose-200 text-xs sm:text-sm flex items-start gap-2.5">
                  <i className="fa-solid fa-circle-exclamation text-rose-400 mt-0.5" />
                  <span>{errorBanner}</span>
                </div>
              )}

              {successBanner && (
                <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-950/60 border border-emerald-800 text-emerald-200 text-xs sm:text-sm flex items-start gap-2.5">
                  <i className="fa-solid fa-circle-check text-emerald-400 mt-0.5" />
                  <span>{successBanner}</span>
                </div>
              )}

              {mode === 'bootstrap' && (
                <form onSubmit={handleBootstrap} className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/70 text-amber-200 text-xs">
                    <strong>First-Run Production Setup (FR-4):</strong> No administrator account exists in this database yet. Create the root Administrator account to initialize LedgerLine.
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Admin Username</label>
                    <input
                      type="text"
                      required
                      value={bootUsername}
                      onChange={(e) => setBootUsername(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Admin Email</label>
                    <input
                      type="email"
                      required
                      placeholder="admin@institution.org"
                      value={bootEmail}
                      onChange={(e) => setBootEmail(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Strong Password (min 8 characters)</label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      value={bootPassword}
                      onChange={(e) => setBootPassword(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white transition-colors"
                  >
                    {submitting ? 'Bootstrapping System...' : 'Initialize Root Administrator'}
                  </button>
                </form>
              )}

              {mode === 'login' && (
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">Username</label>
                    <input
                      type="text"
                      required
                      autoComplete="username"
                      placeholder="Enter your username (e.g. alice, admin, auditor)"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">Password</label>
                    <input
                      type="password"
                      required
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white shadow-lg shadow-emerald-950/40 transition-colors"
                  >
                    {submitting ? 'Authenticating...' : 'Sign In to LedgerLine'}
                  </button>
                </form>
              )}

              {mode === 'register' && (
                <form onSubmit={handleRegister} className="space-y-4">
                  <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700 text-xs text-slate-300">
                    Self-registration opens an <strong>Account Holder</strong> profile in{' '}
                    <code className="text-amber-300">PENDING_APPROVAL</code> status. An administrator must approve onboarding before first sign-in.
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">Username</label>
                    <input
                      type="text"
                      required
                      placeholder="Choose a unique username"
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">Email Address</label>
                    <input
                      type="email"
                      required
                      placeholder="you@example.com"
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">Password (minimum 8 characters)</label>
                    <input
                      type="password"
                      required
                      minLength={8}
                      placeholder="Choose a strong password"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-semibold text-white transition-colors"
                  >
                    {submitting ? 'Creating Application...' : 'Submit Onboarding Application'}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
