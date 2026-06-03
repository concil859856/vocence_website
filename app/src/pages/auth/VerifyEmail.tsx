import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { api } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

/** Landing page for the verification link emailed during signup.
 *  Reads ?token=... from the URL, POSTs it to the verify endpoint,
 *  and on success installs the JWT and redirects to /studio. */
export function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { setSession } = useAuth();

  const [state, setState] = useState<'pending' | 'success' | 'error'>('pending');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token') || '';
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
        // Quick celebration, then send them into the product.
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
  }, [params, setSession, navigate]);

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
            <Link to="/" className="btn-primary inline-flex">
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
