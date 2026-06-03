import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { api } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

/** Read the verification token from the URL.
 *
 *  We prefer the URL fragment (`#token=...`) over query string
 *  (`?token=...`) for the same reason every modern OAuth flow does:
 *  fragments are NEVER sent to servers, so they don't end up in CDN /
 *  proxy / load-balancer access logs. We also accept `?token=` for
 *  backwards compatibility with any older email links still in transit.
 *
 *  Audit findings closed:
 *    C4 — Referer leak when user clicks a link on this page
 *    C5 — CDN/proxy access logs capturing the bearer token
 *
 *  After we read the token we immediately strip it from the URL with
 *  history.replaceState so even browser-history sync / bystanders /
 *  same-origin Referer headers stop seeing it. */
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

export function VerifyEmail() {
  const navigate = useNavigate();
  const { setSession } = useAuth();

  const [state, setState] = useState<'pending' | 'success' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);

  // Ref-based consume guard so the same token is never POSTed twice.
  // Audit C3: React StrictMode double-mounts effects in dev, and any
  // future provider re-render that changes the deps would refire the
  // effect, double-consuming the single-use token and showing the
  // user an "expired" error AFTER they actually verified.
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;

    const token = readTokenFromUrl();
    stripTokenFromUrl();

    if (!token) {
      setState('error');
      setError('No verification token in the link.');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await api.emailVerify(token);
        if (cancelled) return;
        setSession({ user: res.user, token: res.token });
        setState('success');
        window.setTimeout(() => {
          if (!cancelled) navigate('/studio', { replace: true });
        }, 1600);
      } catch (e) {
        if (cancelled) return;
        setState('error');
        setError(e instanceof Error ? e.message : 'Verification failed.');
      }
    })();
    return () => { cancelled = true; };
    // setSession is now stable (useCallback). navigate from
    // react-router is stable. So this effect runs exactly once per
    // mount — and the ref guard catches the StrictMode double-mount.
  }, [setSession, navigate]);

  return (
    <div className="min-h-screen pt-24 bg-[#07080A] flex items-center justify-center px-4">
      <div className="card-vocence p-8 max-w-md w-full text-center">
        {state === 'pending' && (
          <>
            <Loader2 size={36} className="mx-auto mb-4 text-[#DFFF00] animate-spin" />
            <h1 className="text-xl font-semibold mb-2">Verifying your email</h1>
            <p className="text-sm text-[#A7B0B7]">Just a moment...</p>
          </>
        )}
        {state === 'success' && (
          <>
            <CheckCircle2 size={36} className="mx-auto mb-4 text-[#DFFF00]" />
            <h1 className="text-xl font-semibold mb-2">Email verified</h1>
            <p className="text-sm text-[#A7B0B7]">
              Welcome to Vocence! Taking you to the studio...
            </p>
          </>
        )}
        {state === 'error' && (
          <>
            <XCircle size={36} className="mx-auto mb-4 text-red-400" />
            <h1 className="text-xl font-semibold mb-2">We couldn't verify your email</h1>
            <p className="text-sm text-[#A7B0B7] mb-6">{error}</p>
            <Link to="/" className="btn-primary inline-flex" rel="noreferrer">
              Go home
            </Link>
            <p className="text-xs text-[#666] mt-4">
              If the link expired, sign in again to receive a new one.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
