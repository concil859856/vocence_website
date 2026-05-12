import { useAuth } from '../contexts/AuthContext';

/**
 * Temporary launch-gate allowlist for Logos (the floating Vocence Assistant)
 * and the Studio Agents feature. Hard-coded by request — no env var so the
 * list can't drift between Vercel scopes. Add an email here to grant
 * access; remove this whole file (and its callers) once the features are
 * publicly launched.
 */
const VOICE_CHAT_ALLOWLIST: ReadonlySet<string> = new Set([
  'axe.vldk@gmail.com',     // owner
  'koyuki@gohalo.ai',
]);

export function useHasVoiceChatAccess(): boolean {
  const { user, isAuthenticated } = useAuth();
  if (!isAuthenticated || !user?.email) return false;
  return VOICE_CHAT_ALLOWLIST.has(user.email.trim().toLowerCase());
}
