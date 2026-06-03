import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Lock, Eye, EyeOff, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../../services/api';

const PASSWORD_MIN = 12;

/** Read the reset token from the URL.
 *
 *  Same strategy as VerifyEmail: prefer fragment, accept query for
 *  backwards compat, strip from URL on mount to keep the token out
 *  of Referer / history / address bar. See VerifyEmail.tsx for the
 *  full rationale and audit-finding cross-reference. */
function readTokenFromUrl(): string {
  const hash = window.location.hash || '';
  if (hash.startsWith('#token=')) {
    return decodeURIComponent(hash.slice('#token='.length));
  }
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || '';
}

function stripTokenFromUrl(): void {
  window.history.replaceState({}, '', window.location.pathname);
}

export function ResetPassword() {
  const navigate = useNavigate();

  // Captured ONCE on mount, then immediately stripped from the URL.
  const tokenRef = useRef<string>('');
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const token = readTokenFromUrl();
    stripTokenFromUrl();
    tokenRef.current = token;
    setHasToken(!!token);
  }, []);

  if (hasToken === null) {
    // Brief flash until we read the URL — render nothing.
    return null;
  }

  if (!hasToken) {
    return (
      <div className="min-h-screen pt-24 bg-[#07080A] flex items-center justify-center px-4">
        <div className="card-vocence p-8 max-w-md w-full text-center">
          <XCircle size={36} className="mx-auto mb-4 text-red-400" />
          <h1 className="text-xl font-semibold mb-2">Invalid reset link</h1>
          <p className="text-sm text-[#A7B0B7] mb-6">No token found in the URL.</p>
          <Link to="/" className="btn-primary inline-flex" rel="noreferrer">Go home</Link>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${PASSWORD_MIN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.emailReset(tokenRef.current, password);
      setDone(true);
      window.setTimeout(() => navigate('/?login=1', { replace: true }), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen pt-24 bg-[#07080A] flex items-center justify-center px-4">
        <div className="card-vocence p-8 max-w-md w-full text-center">
          <CheckCircle2 size={36} className="mx-auto mb-4 text-[#DFFF00]" />
          <h1 className="text-xl font-semibold mb-2">Password updated</h1>
          <p className="text-sm text-[#A7B0B7]">Taking you to log in...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-24 bg-[#07080A] flex items-center justify-center px-4">
      <div className="card-vocence p-8 max-w-md w-full">
        <h1 className="text-2xl font-semibold mb-2">Choose a new password</h1>
        <p className="text-sm text-[#A7B0B7] mb-6">
          Pick something strong, you won't be able to undo this.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label-mono mb-2 block">New password</label>
            <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-3 flex items-center gap-3 focus-within:border-white/30">
              <Lock size={18} className="text-[#666]" />
              <input
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`At least ${PASSWORD_MIN} characters`}
                className="flex-1 bg-transparent text-white placeholder-[#666] outline-none"
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={128}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="text-[#666] hover:text-white"
                aria-label={show ? 'Hide password' : 'Show password'}
              >
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <label className="label-mono mb-2 block">Confirm new password</label>
            <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-3 flex items-center gap-3 focus-within:border-white/30">
              <Lock size={18} className="text-[#666]" />
              <input
                type={show ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Type it again"
                className="flex-1 bg-transparent text-white placeholder-[#666] outline-none"
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={128}
              />
            </div>
            {/* L53: inline mismatch indicator. Only shown once the
             * user has typed something in confirm AND it disagrees
             * with password — silent otherwise so we don't warn on
             * a half-typed field. */}
            {confirm.length > 0 && password !== confirm ? (
              <p className="text-xs text-red-400 mt-2">Passwords don't match yet.</p>
            ) : (
              <p className="text-xs text-[#666] mt-2">
                Use at least {PASSWORD_MIN} characters with 3 of: lowercase, uppercase, digit, symbol.
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || password.length < PASSWORD_MIN || password !== confirm}
            className="w-full py-3 px-4 rounded-xl bg-white text-black font-medium hover:bg-[#DFFF00] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? 'Updating...' : 'Set new password'}
          </button>
        </form>
      </div>
    </div>
  );
}
