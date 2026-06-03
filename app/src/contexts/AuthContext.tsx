import { createContext, useContext, useState, useEffect } from 'react';
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
    // Check for existing session on mount
    const checkSession = async () => {
      try {
        const storedToken = localStorage.getItem('vocence_token');
        const storedUser = localStorage.getItem('vocence_user');

        if (storedToken && storedUser) {
          try {
            // Check if API is configured (not using default fallback)
            const hasApiConfigured = Boolean(import.meta.env.VITE_API_URL);
            
            if (hasApiConfigured) {
              // Try to verify with API
              try {
                const userData = await api.verifyToken(storedToken);
                setUser(userData);
                localStorage.setItem('vocence_user', JSON.stringify(userData));
              } catch (apiError) {
                // API failed, fallback to localStorage
                console.warn('API not available, using localStorage fallback');
                const userData = JSON.parse(storedUser);
                setUser(userData);
              }
            } else {
              // No API configured, use localStorage directly
              const userData = JSON.parse(storedUser);
              setUser(userData);
            }
          } catch (error) {
            // If API fails, fallback to localStorage
            console.warn('API not available, using localStorage fallback:', error);
            try {
              const userData = JSON.parse(storedUser);
              setUser(userData);
            } catch (parseError) {
              console.error('Failed to parse stored user:', parseError);
              localStorage.removeItem('vocence_token');
              localStorage.removeItem('vocence_user');
            }
          }
        } else if (storedUser) {
          // Fallback: use stored user if no token
          try {
            const userData = JSON.parse(storedUser);
            setUser(userData);
          } catch (parseError) {
            console.error('Failed to parse stored user:', parseError);
            localStorage.removeItem('vocence_user');
          }
        }
      } catch (error) {
        console.error('Failed to restore session:', error);
        // Clear invalid session
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

      // Save user and token
      setUser(response.user);
      localStorage.setItem('vocence_user', JSON.stringify(response.user));
      localStorage.setItem('vocence_token', response.token);
      // Register user in dashboard backend (local SQLite) for admin user list
      dashboardApi.registerUser({
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
      }).catch(() => {});
    } catch (error) {
      // Fallback to localStorage if API is not available. The
      // ``credential`` arg the new ``loginOrSignup`` type requires
      // isn't useful here, the offline path can't verify with
      // Google anyway, but we satisfy the type to keep callers
      // strict-typed.
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
      localStorage.setItem('vocence_token', response.token);
      // Register user in dashboard backend (local SQLite)
      dashboardApi.registerUser({
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
      }).catch(() => {});
    } finally {
      setIsLoading(false);
    }
  };

  const setSession = ({ user: nextUser, token }: { user: User; token: string }) => {
    setUser(nextUser);
    localStorage.setItem('vocence_user', JSON.stringify(nextUser));
    localStorage.setItem('vocence_token', token);
    // Mirror to dashboardApi.registerUser the same way the Google
    // login does, best-effort.
    dashboardApi.registerUser({
      email: nextUser.email,
      name: nextUser.name,
      picture: nextUser.picture ?? undefined,
    }).catch(() => {});
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem('vocence_user');
    localStorage.removeItem('vocence_token');
  };

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

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        setSession,
        logout,
        updateCredits,
        setLocalCredits,
        isAuthenticated: !!user,
        isLoading,
      }}
    >
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

