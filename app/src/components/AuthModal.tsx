import { useEffect, useRef, useState } from 'react';
import { X, Mail, Lock, Eye, EyeOff, ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GoogleLogin } from '@react-oauth/google';
import type { CredentialResponse } from '@react-oauth/google';
import { api } from '../services/api';
import { getStoredReferralCode, clearStoredReferralCode, getDeviceFingerprint } from '../lib/referral';

/** Map backend error strings to user-safe UI messages.
 *
 *  Audit H11: previously the modal surfaced backend ``detail`` verbatim
 *  via setError(e.message). That leaked:
 *    - account existence ("Account locked..." confirms account is real)
 *    - credential validity (post-H5 fix the backend no longer does this,
 *      but defense-in-depth — never reflect backend strings without filter)
 *    - submitted passwords ("This password is too common: ..." would
 *      echo the candidate to a shoulder-surfer if backend ever did so)
 *
 *  Strategy: a small allowlist of GENERIC strings UI is allowed to show.
 *  Anything else → fall back to a per-flow generic.
 */
function mapSignInError(rawMsg: string): string {
  const m = rawMsg.toLowerCase();
  // Password-policy hints during signup — useful, no info leak.
  if (m.includes('characters or fewer') || m.includes('at least') || m.includes('character classes') || m.includes('uppercase, digit')) {
    return rawMsg;
  }
  // Rate limit — surface generic; never confirm account existence.
  if (m.includes('too many') || m.includes('locked') || m.includes('try again later')) {
    return 'Too many attempts. Please try again later.';
  }
  // Generic invalid-credential — surface as-is, it's already generic.
  if (m === 'invalid email or password.') {
    return rawMsg;
  }
  // Catch-all — don't surface backend text we don't explicitly allow.
  return 'Sign-in failed. Please try again.';
}

function mapSignupError(rawMsg: string): string {
  const m = rawMsg.toLowerCase();
  // Password-rule hints are fine to show.
  if (m.includes('at least') || m.includes('characters or fewer') || m.includes('character classes') || m.includes('uppercase, digit')) {
    return rawMsg;
  }
  // Common-password warning: surface a generic phrasing that doesn't
  // echo the candidate to a shoulder-surfer.
  if (m.includes('too common')) {
    return 'Please choose a stronger password.';
  }
  // Email validity hints are fine.
  if (m.includes('email')) {
    return rawMsg;
  }
  if (m.includes('too many') || m.includes('try again later')) {
    return 'Too many attempts. Please try again later.';
  }
  return 'Could not create account. Please try again.';
}

function mapResetError(rawMsg: string): string {
  const m = rawMsg.toLowerCase();
  if (m.includes('too many') || m.includes('try again later')) {
    return 'Too many attempts. Please try again later.';
  }
  return 'Could not send reset email. Please try again.';
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'login' | 'signup';
}

/** Internal state machine for the email flow. ``form`` is the default
 *  view (email + password). ``forgot`` is the password-reset request
 *  form. ``check-inbox-signup`` and ``check-inbox-forgot`` are the
 *  success screens shown after we've emailed a link. */
type Screen = 'form' | 'forgot' | 'check-inbox-signup' | 'check-inbox-forgot';

const PASSWORD_MIN = 12;

export function AuthModal({ isOpen, onClose, initialMode = 'login' }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const [screen, setScreen] = useState<Screen>('form');
  const [tosAccepted, setTosAccepted] = useState(false);
  const { login, setSession } = useAuth();

  // Email form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailedTo, setEmailedTo] = useState('');

  // Audit H12: track open/mounted state so an in-flight request that
  // settles AFTER the modal is closed doesn't (a) trigger setState
  // on an unmounted-but-still-around component, or (b) silently log
  // the user in when they intentionally cancelled. We can't abort
  // the fetch mid-flight (api.ts uses bare fetch without signals),
  // but we can ignore its result.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Bumps every time the modal opens. Each request snapshots the
  // current value; if it doesn't match at completion time, the user
  // closed the modal between submit and response → discard the result.
  const requestEpochRef = useRef(0);
  useEffect(() => {
    if (isOpen) requestEpochRef.current += 1;
  }, [isOpen]);

  if (!isOpen) return null;

  const resetForm = () => {
    setEmail(''); setPassword(''); setName('');
    setError(null); setBusy(false);
    setShowPassword(false); setEmailedTo('');
  };

  const closeAll = () => { resetForm(); setScreen('form'); onClose(); };

  const switchMode = (next: 'login' | 'signup') => {
    setMode(next);
    setScreen('form');
    setError(null);
  };

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) return;
    try {
      const base64Url = credentialResponse.credential.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      const payload = JSON.parse(jsonPayload);
      await login({
        id: payload.sub,
        email: payload.email,
        name: payload.name || payload.email.split('@')[0],
        picture: payload.picture,
        credential: credentialResponse.credential,
      });
      closeAll();
    } catch (e) {
      console.error('Failed to authenticate:', e);
      setError('Failed to authenticate with Google. Please try again.');
    }
  };

  const handleGoogleError = () => {
    setError('Google authentication failed. Please try again.');
  };

  // ── Email form actions ─────────────────────────────────────────────
  //
  // Audit H12: each submit captures the current request epoch into
  // ``epoch`` and only commits state to the component if the epoch
  // still matches at completion time. If the user closed/reopened
  // the modal between submit and response, we discard the result.
  // ``mountedRef`` is a final safety belt.

  const _shouldCommit = (epoch: number) => mountedRef.current && epoch === requestEpochRef.current;

  const submitEmailLogin = async () => {
    setError(null); setBusy(true);
    const epoch = requestEpochRef.current;
    try {
      const res = await api.emailLogin(email.trim(), password);
      if (!_shouldCommit(epoch)) return;
      setSession({ user: res.user, token: res.token });
      closeAll();
    } catch (e) {
      if (!_shouldCommit(epoch)) return;
      setError(mapSignInError(e instanceof Error ? e.message : 'Login failed'));
    } finally {
      if (_shouldCommit(epoch)) setBusy(false);
    }
  };

  const submitEmailSignup = async () => {
    setError(null); setBusy(true);
    const epoch = requestEpochRef.current;
    try {
      await api.emailSignup({
        email: email.trim(),
        password,
        name: name.trim() || undefined,
        referral_code: getStoredReferralCode() ?? undefined,
        device_fingerprint: getDeviceFingerprint() ?? undefined,
      });
      if (!_shouldCommit(epoch)) return;
      clearStoredReferralCode();
      setEmailedTo(email.trim());
      setScreen('check-inbox-signup');
    } catch (e) {
      if (!_shouldCommit(epoch)) return;
      setError(mapSignupError(e instanceof Error ? e.message : 'Signup failed'));
    } finally {
      if (_shouldCommit(epoch)) setBusy(false);
    }
  };

  const submitForgot = async () => {
    setError(null); setBusy(true);
    const epoch = requestEpochRef.current;
    try {
      await api.emailForgot(email.trim());
      if (!_shouldCommit(epoch)) return;
      setEmailedTo(email.trim());
      setScreen('check-inbox-forgot');
    } catch (e) {
      if (!_shouldCommit(epoch)) return;
      setError(mapResetError(e instanceof Error ? e.message : 'Could not send reset email'));
    } finally {
      if (_shouldCommit(epoch)) setBusy(false);
    }
  };

  // ── Form-level validation hints (UI only — server is the source of truth) ──

  const passwordTooShort = mode === 'signup' && password.length > 0 && password.length < PASSWORD_MIN;
  const emailFormValid = email.trim().length > 0 && password.length >= (mode === 'signup' ? PASSWORD_MIN : 1);
  const ctaDisabled = busy || !tosAccepted || !emailFormValid;

  // ── Render: header + content per screen ────────────────────────────

  const header = (() => {
    if (screen === 'forgot') {
      return { title: 'Reset password', subtitle: "Enter your email and we'll send a reset link." };
    }
    if (screen === 'check-inbox-signup') {
      return { title: 'Check your inbox', subtitle: `We sent a verification link to ${emailedTo}.` };
    }
    if (screen === 'check-inbox-forgot') {
      return { title: 'Check your inbox', subtitle: `If an account exists for ${emailedTo}, we sent a reset link.` };
    }
    return {
      title: mode === 'login' ? 'Log In' : 'Sign Up',
      subtitle: mode === 'login'
        ? 'Welcome back! Sign in to continue.'
        : 'Create an account to get started.',
    };
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={closeAll} />

      <div className="relative z-10 w-full max-w-md mx-4">
        <div className="card-vocence p-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-start gap-2">
              {(screen === 'forgot' || screen === 'check-inbox-signup' || screen === 'check-inbox-forgot') && (
                <button
                  onClick={() => { resetForm(); setScreen('form'); }}
                  className="mt-1 p-1 -ml-1 text-[#A7B0B7] hover:text-white"
                  aria-label="Back"
                >
                  <ArrowLeft size={18} />
                </button>
              )}
              <div>
                <h2 className="text-2xl font-semibold mb-1">{header.title}</h2>
                <p className="text-sm text-[#A7B0B7]">{header.subtitle}</p>
              </div>
            </div>
            <button onClick={closeAll} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
              <X size={20} />
            </button>
          </div>

          {/* "Check inbox" success screens */}
          {(screen === 'check-inbox-signup' || screen === 'check-inbox-forgot') && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-[#DFFF00]/8 border border-[#DFFF00]/20">
                <CheckCircle2 size={20} className="text-[#DFFF00] shrink-0 mt-0.5" />
                <p className="text-sm text-white/90 leading-relaxed">
                  {screen === 'check-inbox-signup'
                    ? "Click the link in the email to verify your address. The link expires in 24 hours."
                    : "Click the link in the email to choose a new password. The link expires in 15 minutes. If you don't see the email, check spam."}
                </p>
              </div>
              <button
                onClick={closeAll}
                className="w-full py-3 px-4 rounded-xl bg-white text-black font-medium hover:bg-[#DFFF00] transition-colors"
              >
                Got it
              </button>
            </div>
          )}

          {/* Default form: login / signup */}
          {screen === 'form' && (
            <div className="space-y-4">
              {/* Google OAuth */}
              {import.meta.env.VITE_GOOGLE_CLIENT_ID ? (
                <div className="flex flex-col items-center">
                  <div className={tosAccepted ? '' : 'opacity-50 pointer-events-none'}>
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={handleGoogleError}
                      useOneTap={false}
                      theme="filled_black"
                      size="large"
                      text={mode === 'login' ? 'signin_with' : 'signup_with'}
                      shape="pill"
                    />
                  </div>
                  {!tosAccepted && (
                    <p className="text-xs text-[#A7B0B7] mt-2">Accept the terms below to continue</p>
                  )}
                </div>
              ) : (
                <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 text-center">
                  <p className="text-sm text-yellow-400 mb-2">Google OAuth not configured</p>
                  <p className="text-xs text-[#A7B0B7]">Set VITE_GOOGLE_CLIENT_ID to enable</p>
                </div>
              )}

              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-white/10" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-4 bg-[#0D1117] text-[#A7B0B7]">Or continue with email</span>
                </div>
              </div>

              {/* Email form */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (ctaDisabled) return;
                  mode === 'signup' ? submitEmailSignup() : submitEmailLogin();
                }}
                className="space-y-3"
              >
                {mode === 'signup' && (
                  <div>
                    <label className="label-mono mb-2 block">Name <span className="text-[#666]">(optional)</span></label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="What should we call you?"
                      className="w-full bg-[#0a0a0a] border border-white/10 rounded-xl px-3 py-2.5 text-white placeholder-[#666] outline-none focus:border-white/30"
                      maxLength={128}
                    />
                  </div>
                )}
                <div>
                  <label className="label-mono mb-2 block">Email</label>
                  <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-3 flex items-center gap-3 focus-within:border-white/30">
                    <Mail size={18} className="text-[#666]" />
                    <input
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="your@email.com"
                      className="flex-1 bg-transparent text-white placeholder-[#666] outline-none"
                      maxLength={254}
                    />
                  </div>
                </div>
                <div>
                  <label className="label-mono mb-2 block">Password</label>
                  <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-3 flex items-center gap-3 focus-within:border-white/30">
                    <Lock size={18} className="text-[#666]" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={mode === 'signup' ? `At least ${PASSWORD_MIN} characters` : 'Your password'}
                      className="flex-1 bg-transparent text-white placeholder-[#666] outline-none"
                      maxLength={128}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="text-[#666] hover:text-white"
                      tabIndex={-1}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  {mode === 'signup' && (
                    <p className={`text-xs mt-2 ${passwordTooShort ? 'text-red-400' : 'text-[#666]'}`}>
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
                  disabled={ctaDisabled}
                  className="w-full py-3 px-4 rounded-xl bg-white text-black font-medium hover:bg-[#DFFF00] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {busy ? (mode === 'signup' ? 'Creating account...' : 'Signing in...') : (mode === 'signup' ? 'Create account' : 'Log in')}
                </button>

                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => { setError(null); setNeedsVerify(false); setScreen('forgot'); }}
                    className="block w-full text-center text-xs text-[#A7B0B7] hover:text-white"
                  >
                    Forgot password?
                  </button>
                )}
              </form>

              {/* Mode toggle */}
              <div className="pt-4 border-t border-white/10">
                <p className="text-sm text-center text-[#A7B0B7]">
                  {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                  <button
                    onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
                    className="text-[#DFFF00] hover:underline font-medium"
                  >
                    {mode === 'login' ? 'Sign up' : 'Log in'}
                  </button>
                </p>
              </div>

              {/* ToS acceptance */}
              <div className="pt-4 border-t border-white/10">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tosAccepted}
                    onChange={(e) => setTosAccepted(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-white/20 accent-[#DFFF00]"
                  />
                  <span className="text-xs text-[#A7B0B7]">
                    I agree to Vocence's{' '}
                    <a href="/terms" target="_blank" rel="noreferrer" className="text-[#DFFF00] hover:underline">Terms of Service</a>
                    {' '}and{' '}
                    <a href="/privacy" target="_blank" rel="noreferrer" className="text-[#DFFF00] hover:underline">Privacy Policy</a>.
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* Forgot password form */}
          {screen === 'forgot' && (
            <form
              onSubmit={(e) => { e.preventDefault(); if (!busy && email.trim()) submitForgot(); }}
              className="space-y-4"
            >
              <div>
                <label className="label-mono mb-2 block">Email</label>
                <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-3 flex items-center gap-3 focus-within:border-white/30">
                  <Mail size={18} className="text-[#666]" />
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className="flex-1 bg-transparent text-white placeholder-[#666] outline-none"
                    maxLength={254}
                  />
                </div>
              </div>

              {error && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={busy || email.trim().length === 0}
                className="w-full py-3 px-4 rounded-xl bg-white text-black font-medium hover:bg-[#DFFF00] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
