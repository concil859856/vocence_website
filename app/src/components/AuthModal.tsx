import { useState } from 'react';
import { X, Mail } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GoogleLogin } from '@react-oauth/google';
import type { CredentialResponse } from '@react-oauth/google';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'login' | 'signup';
}

export function AuthModal({ isOpen, onClose, initialMode = 'login' }: AuthModalProps) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode);
  const { login } = useAuth();

  if (!isOpen) return null;

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) return;
    // SECURITY: we still client-side-decode the JWT to populate hint
    // fields for the offline localStorage fallback path, but those
    // values are NOT trusted by the backend. The backend verifies the
    // raw credential against Google's tokeninfo endpoint and uses the
    // verified claims; the client-decoded values are advisory only.
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
      onClose();
    } catch (error) {
      console.error('Failed to authenticate:', error);
      alert('Failed to authenticate. Please try again.');
    }
  };

  const handleGoogleError = () => {
    console.error('Google authentication failed');
    alert('Google authentication failed. Please try again.');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-md mx-4">
        <div className="card-vocence p-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-semibold mb-1">
                {mode === 'login' ? 'Log In' : 'Sign Up'}
              </h2>
              <p className="text-sm text-[#A7B0B7]">
                {mode === 'login'
                  ? 'Welcome back! Sign in to continue.'
                  : 'Create an account to get started.'}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {/* Google OAuth */}
          <div className="space-y-4">
            {import.meta.env.VITE_GOOGLE_CLIENT_ID ? (
              <div className="flex flex-col items-center">
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
            ) : (
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 text-center">
                <p className="text-sm text-yellow-400 mb-2">
                  Google OAuth not configured
                </p>
                <p className="text-xs text-[#A7B0B7]">
                  Please set VITE_GOOGLE_CLIENT_ID in your .env file
                </p>
              </div>
            )}

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/10"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-4 bg-[#0D1117] text-[#A7B0B7]">
                  Or continue with email
                </span>
              </div>
            </div>

            {/* Email form (placeholder for future implementation) */}
            <div className="space-y-4">
              <div>
                <label className="label-mono mb-2 block">Email</label>
                <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-3 flex items-center gap-3">
                  <Mail size={18} className="text-[#666]" />
                  <input
                    type="email"
                    placeholder="your@email.com"
                    className="flex-1 bg-transparent text-white placeholder-[#666] outline-none"
                    disabled
                  />
                </div>
                <p className="text-xs text-[#666] mt-2">
                  Email authentication coming soon
                </p>
              </div>
            </div>

            {/* Mode Toggle */}
            <div className="pt-4 border-t border-white/10">
              <p className="text-sm text-center text-[#A7B0B7]">
                {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                <button
                  onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
                  className="text-[#DFFF00] hover:underline font-medium"
                >
                  {mode === 'login' ? 'Sign up' : 'Log in'}
                </button>
              </p>
            </div>

            {/* Info */}
            <div className="pt-4 border-t border-white/10">
              <p className="text-xs text-[#666] text-center">
                By continuing, you agree to Vocence's Terms of Service and Privacy Policy.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

