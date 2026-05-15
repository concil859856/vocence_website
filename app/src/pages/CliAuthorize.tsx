/**
 * CLI device-code approval page — /cli/authorize?user_code=ABCD-1234
 *
 * When a user runs ``vocence login`` the CLI opens this page. We confirm
 * the user_code, then they click Approve (mints a fresh API key bound to
 * the device_code) or Deny (kills the request). The CLI is polling the
 * dashboard-backend in the background and picks up the result.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Check, X, KeyRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

type State = 'idle' | 'approving' | 'approved' | 'denying' | 'denied' | 'error';

export function CliAuthorize() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { user, token } = useAuth();
  const initialCode = (search.get('user_code') || '').toUpperCase();
  const [userCode, setUserCode] = useState(initialCode);
  const [keyName, setKeyName] = useState('cli');
  const [state, setState] = useState<State>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // If not signed in, bounce to login and come back here.
  useEffect(() => {
    if (!user) {
      const next = encodeURIComponent(`/cli/authorize?user_code=${userCode}`);
      navigate(`/?login=1&next=${next}`, { replace: true });
    }
  }, [user, userCode, navigate]);

  const callApi = async (path: '/api/cli/approve' | '/api/cli/deny') => {
    const base =
      (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ||
      'https://backend.vocence.ai';
    const resp = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ user_code: userCode.trim().toUpperCase(), key_name: keyName.trim() || 'cli' }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${resp.status}`);
    }
  };

  const approve = async () => {
    setErrorMsg(null);
    setState('approving');
    try {
      await callApi('/api/cli/approve');
      setState('approved');
    } catch (e) {
      setState('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const deny = async () => {
    setErrorMsg(null);
    setState('denying');
    try {
      await callApi('/api/cli/deny');
      setState('denied');
    } catch (e) {
      setState('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-12 px-4">
      <div className="mx-auto max-w-md rounded-2xl border border-white/[0.08] bg-[#0B0D10] p-8">
        <div className="mb-6 flex items-center gap-2 text-[#DFFF00]">
          <KeyRound size={20} />
          <h1 className="text-xl font-semibold text-white">Authorize CLI</h1>
        </div>

        {state === 'approved' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">
              <Check className="mb-1 inline" size={16} /> Authorized. Return to your terminal — the CLI
              has already received the new key.
            </div>
            <Link to="/account/developer" className="text-sm text-zinc-400 underline">
              Manage your keys →
            </Link>
          </div>
        )}

        {state === 'denied' && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">
            Denied. The terminal will show an error and stop polling.
          </div>
        )}

        {(state === 'idle' || state === 'approving' || state === 'denying' || state === 'error') && (
          <>
            <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-[12px] leading-relaxed text-amber-100">
              <strong className="font-semibold">Security check.</strong>{' '}
              Approving will mint a new API key (with FULL access to your
              account, including credits) and hand it to whoever is polling
              for this code. Only proceed if you personally started{' '}
              <code className="rounded bg-black/30 px-1">vocence login</code>{' '}
              in your terminal AND the code below matches what's displayed there.
            </div>
            <p className="mb-4 text-sm leading-relaxed text-zinc-400">
              A Vocence CLI is asking to create a new API key on your account. Confirm the
              code matches your terminal, pick a label, and click{' '}
              <span className="text-zinc-200">Authorize</span>.
            </p>

            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Code from your terminal
            </label>
            <input
              type="text"
              value={userCode}
              onChange={(e) => setUserCode(e.target.value.toUpperCase())}
              spellCheck={false}
              className="mb-4 w-full rounded-lg border border-white/[0.10] bg-black/40 px-3 py-2 font-mono tracking-widest text-zinc-100 focus:border-white/30 focus:outline-none"
            />

            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Key label (so you can spot this key later)
            </label>
            <input
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="laptop"
              className="mb-6 w-full rounded-lg border border-white/[0.10] bg-black/40 px-3 py-2 text-sm text-zinc-100 focus:border-white/30 focus:outline-none"
            />

            {errorMsg && (
              <div className="mb-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200">
                {errorMsg}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={approve}
                disabled={state === 'approving' || !userCode.trim()}
                className="flex-1 rounded-lg bg-[#DFFF00] px-4 py-2 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {state === 'approving' ? 'Authorizing…' : 'Authorize'}
              </button>
              <button
                type="button"
                onClick={deny}
                disabled={state === 'denying' || !userCode.trim()}
                className="inline-flex items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/[0.04] px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.08] disabled:opacity-50"
              >
                <X size={14} />
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
