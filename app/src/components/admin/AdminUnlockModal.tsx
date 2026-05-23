/**
 * Admin sudo-mode modal — pops on first /admin/ops visit (or whenever the
 * admin_token has expired) and prompts for the separate admin password.
 *
 * Wire-compatible with routers/admin_auth.py:
 *   POST /api/dashboard/auth/admin/unlock {password}
 *     -> {admin_token, expires_at, session_ttl_hours}
 */
import { useEffect, useRef, useState } from 'react';
import { Lock, ShieldAlert } from 'lucide-react';
import { adminAuthApi, setStoredAdminToken } from '../../lib/admin/api';

interface Props {
  token: string;                       // user's JWT (Google OAuth)
  onUnlocked: () => void;              // parent re-renders with adminToken
  onCancel?: () => void;               // optional: navigate away
}

export function AdminUnlockModal({ token, onUnlocked, onCancel }: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await adminAuthApi.unlock(token, password);
      setStoredAdminToken(r.admin_token, r.expires_at);
      onUnlocked();
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 429) {
        setError(`Rate limited. ${err.message}`);
      } else if (err.status === 401) {
        setError('Invalid admin password.');
      } else if (err.status === 503) {
        setError(
          'Admin password not configured on backend. ' +
          'Generate one with: python -m routers.admin_auth --hash, ' +
          'add to .env as ADMIN_PASSWORD_HASH, restart backend.',
        );
      } else {
        setError(err.message || 'Unlock failed');
      }
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d0e10] border border-white/15 rounded-2xl max-w-md w-full p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-[#DFFF00]/10 border border-[#DFFF00]/30 flex items-center justify-center">
            <Lock size={18} className="text-[#DFFF00]" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Admin verification</h3>
            <p className="text-xs text-[#A7B0B7]">
              Enter the admin password to unlock the Ops console.
            </p>
          </div>
        </div>

        <p className="text-xs text-[#A7B0B7] mb-4 leading-relaxed">
          Even as an admin, the Ops surface (servers, pods, fleet analytics)
          requires a second factor. This unlock is valid for the session — it
          clears when you close the browser.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            disabled={submitting}
            autoComplete="current-password"
            className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40"
          />

          {error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-xs px-3 py-2 flex items-start gap-2">
              <ShieldAlert size={14} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                className="text-sm text-[#A7B0B7] hover:text-white px-4 py-2 disabled:opacity-50"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={submitting || !password}
              className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? 'Verifying…' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
