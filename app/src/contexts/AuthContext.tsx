import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { api, localStorageFallback } from '../services/api';
import type { User } from '../services/api';
import { dashboardApi } from '../services/dashboardApi';
import { getStoredReferralCode, clearStoredReferralCode, getDeviceFingerprint } from '../lib/referral';

interface AuthContextType {
  user: User | null;
  login: (userData: { id: string; email: string; name: string; picture?: string; credential: string }) => Promise<void>;
  /** Install a pre-authenticated session (user + JWT) without going
   *  through Google. Used by the email/password login flow and the
   *  email-verification landing page, both of which receive a
   *  ready-to-use {user, token} from the backend. */
  setSession: (args: { user: User; token: string }) => void;
  logout: () => void;
  /** Persist a new absolute credit balance to the server (writes a `manual_adjustment` ledger row).
   *  Use ONLY for client-side flows that don't go through a server-side job (e.g. the chat demo).
   *  For TTS/STT/clone/music/voice_design, the server already deducts via `_charge_credits` —
   *  use `setLocalCredits` to mirror the deduction in local UI state, and add it back on failure. */
  updateCredits: (credits: number) => Promise<void>;
  /** Update only the local React state + localStorage. Does NOT call the server.
   *  Pair with server-side jobs that already deducted via `_charge_credits`. */
  setLocalCredits: (credits: number) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check for existing session on mount.
    //
    // Post-phase-4 behaviour: the JWT lives ONLY in the HttpOnly
    // ``vocence_session`` cookie. We hit /api/auth/verify with no
    // body — the cookie travels via authFetch's
    // ``credentials: 'include'`` — and the backend tells us who we
    // are if the cookie is valid.
    //
    // Legacy compat: a pre-migration user might still have a JWT in
    // localStorage but no cookie yet. We present that JWT to the
    // verify endpoint via the body so the backend can install the
    // cookie (the opportunistic-upgrade behaviour we added in
    // backend phase 1). Then we ALWAYS clear the localStorage JWT —
    // the cookie is the only sanctioned storage from here on.
    const checkSession = async () => {
      try {
        const legacyToken = localStorage.getItem('vocence_token');
        const storedUser = localStorage.getItem('vocence_user');
        // Always remove the legacy JWT from localStorage. Even if
        // the verify call fails, we never want the JWT sitting where
        // an XSS could read it.
        if (legacyToken) localStorage.removeItem('vocence_token');

        try {
          // If we have a legacy token, present it so the backend
          // installs the cookie. Otherwise just rely on whatever
          // cookie the browser already has.
          const userData = legacyToken
            ? await api.verifyToken(legacyToken)
            : await api.verifyCurrentSession();
          setUser(userData);
          localStorage.setItem('vocence_user', JSON.stringify(userData));
        } catch (apiError) {
          // No valid session, either token expired / cleared or
          // server unreachable. Fall back to whatever local user
          // we've cached (purely for offline-display purposes — they
          // can't make authed calls without a session anyway).
          if (storedUser) {
            try {
              setUser(JSON.parse(storedUser));
            } catch {
              localStorage.removeItem('vocence_user');
            }
          }
        }
      } catch (error) {
        console.error('Failed to restore session:', error);
        localStorage.removeItem('vocence_token');
        localStorage.removeItem('vocence_user');
      } finally {
        setIsLoading(false);
      }
    };

    checkSession();
  }, []);

  const login = async (userData: { id: string; email: string; name: string; picture?: string; credential: string }) => {
    try {
      setIsLoading(true);

      // SECURITY: backend verifies ``credential`` against Google's
      // tokeninfo endpoint and IGNORES the email/name/picture/googleId
      // fields. We still forward them as hints for the localStorage
      // fallback path (which can't verify on its own).
      const response = await api.loginOrSignup({
        credential: userData.credential,
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
        googleId: userData.id,
        referral_code: getStoredReferralCode(),
        device_fingerprint: getDeviceFingerprint(),
      });
      clearStoredReferralCode();

      // Phase 4: session JWT now lives in the HttpOnly vocence_session
      // cookie set by the backend. We persist only the user object
      // (display name, avatar, plan etc.) in localStorage — those
      // aren't credentials, just metadata for instant first-paint.
      setUser(response.user);
      localStorage.setItem('vocence_user', JSON.stringify(response.user));
      dashboardApi.registerUser({
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
      }).catch(() => {});
    } catch (error) {
      // Fallback path runs when the API is unreachable (e.g. true
      // localhost-only dev). It can't actually authenticate — there's
      // no real session cookie — but it lets the UI render the user's
      // cached identity so they don't see a blank "please log in"
      // screen during a backend outage.
      console.warn('API not available, using localStorage fallback');
      const response = localStorageFallback.loginOrSignup({
        credential: userData.credential,
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
        googleId: userData.id,
      });

      setUser(response.user);
      localStorage.setItem('vocence_user', JSON.stringify(response.user));
      dashboardApi.registerUser({
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
      }).catch(() => {});
    } finally {
      setIsLoading(false);
    }
  };

  // MUST be useCallback. The verify page's effect depends on this
  // reference; without useCallback, every AuthProvider render rebuilds
  // the function and triggers the effect to re-run, which would
  // double-POST the single-use verify token and burn it (audit C3).
  //
  // M34 polish: mirror login()'s isLoading flag so any consumer gated
  // on isLoading (route guards, splash screens) sees the brief
  // installation window. The registration call is still fire-and-
  // forget on initial attempt — for email-verify users this is the
  // FIRST time the dashboard backend hears of them, but a transient
  // failure here doesn't block login. We retry on the next page
  // load via the normal login path.
  // The ``token`` parameter is now ignored — the JWT travels via
  // the HttpOnly cookie the backend set on the response that
  // produced this call (email login/verify endpoints). We keep the
  // parameter on the signature so callers don't need to change in
  // lockstep; it can be dropped in a future cleanup pass.
  const setSession = useCallback(({ user: nextUser, token: _ignored }: { user: User; token: string }) => {
    setIsLoading(true);
    try {
      setUser(nextUser);
      localStorage.setItem('vocence_user', JSON.stringify(nextUser));
      dashboardApi.registerUser({
        email: nextUser.email,
        name: nextUser.name,
        picture: nextUser.picture ?? undefined,
      }).catch((err) => {
        console.warn('dashboardApi.registerUser failed (will retry on next login):', err);
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    // Fire-and-forget the server-side cookie clear. Don't await — we
    // want the UI to update immediately even if the backend is slow
    // or unreachable. Worst case the cookie stays set on the server's
    // domain until natural expiry (30 days), but the local state is
    // already gone so this client can't use it.
    api.logout().catch(() => {});
    setUser(null);
    localStorage.removeItem('vocence_user');
    localStorage.removeItem('vocence_token');
  }, []);

  const setLocalCredits = (credits: number) => {
    if (!user) return;
    const updatedUser = { ...user, credits };
    setUser(updatedUser);
    localStorage.setItem('vocence_user', JSON.stringify(updatedUser));
  };

  const updateCredits = async (credits: number) => {
    if (!user) return;

    try {
      const token = localStorage.getItem('vocence_token');
      
      if (token) {
        // Try to update via API
        const updatedUser = await api.updateCredits(user.id, credits, token);
        setUser(updatedUser);
        localStorage.setItem('vocence_user', JSON.stringify(updatedUser));
      } else {
        // Fallback to localStorage
        const updatedUser = localStorageFallback.updateCredits(user.id, credits);
        if (updatedUser) {
          setUser(updatedUser);
          localStorage.setItem('vocence_user', JSON.stringify(updatedUser));
        }
      }
    } catch (error) {
      console.error('Failed to update credits:', error);
      // Fallback to localStorage
      const updatedUser = localStorageFallback.updateCredits(user.id, credits);
      if (updatedUser) {
        setUser(updatedUser);
        localStorage.setItem('vocence_user', JSON.stringify(updatedUser));
      }
    }
  };

  // Memoize the context value so consumers whose effects depend on
  // any field don't re-run every AuthProvider render. Pairs with the
  // useCallback on setSession above; both are required to prevent
  // VerifyEmail.tsx from double-consuming the verification token.
  const ctxValue = useMemo(
    () => ({
      user,
      login,
      setSession,
      logout,
      updateCredits,
      setLocalCredits,
      isAuthenticated: !!user,
      isLoading,
    }),
    [user, login, setSession, logout, updateCredits, setLocalCredits, isLoading],
  );

  return (
    <AuthContext.Provider value={ctxValue}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

