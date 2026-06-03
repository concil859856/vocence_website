import { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Lock, Eye, EyeOff, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../../services/api';

const PASSWORD_MIN = 12;

/** Landing page for the password-reset link emailed by /auth/email/forgot.
 *  Reads ?token=... from the URL, asks for a new password, POSTs both
 *  to /auth/email/reset, then redirects to the login modal. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!token) {
    return (
      <div className="min-h-screen pt-24 bg-[#07080A] flex items-center justify-center px-4">
        <div className="card-vocence p-8 max-w-md w-full text-center">
          <XCircle size={36} className="mx-auto mb-4 text-red-400" />
          <h1 className="text-xl font-semibold mb-2">Invalid reset link</h1>
          <p className="text-sm text-[#A7B0B7] mb-6">No token found in the URL.</p>
          <Link to="/" className="btn-primary inline-flex">Go home</Link>
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
      await api.emailReset(token, password);
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
                maxLength={128}
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="text-[#666] hover:text-white"
                tabIndex={-1}
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
                maxLength={128}
              />
            </div>
            <p className="text-xs text-[#666] mt-2">
              Use at least {PASSWORD_MIN} characters with 3 of: lowercase, uppercase, digit, symbol.
            </p>
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
