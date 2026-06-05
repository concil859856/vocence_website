import { useAuth } from '../contexts/AuthContext';
import { ADMIN_EMAIL } from '../config';

/**
 * Launch gate for Logos (the floating Vocence Assistant) and the Studio
 * Agents feature. Both are admin-only until publicly launched: the hook
 * returns true only when the signed-in user's email matches the
 * VITE_ADMIN_EMAIL env. Remove this file (and its callers) once these
 * features are released to all users.
 *
 * The "voicechat access" name is kept so existing callers don't churn —
 * semantically it now means "may see the not-yet-launched voice agents
 * and Logos surfaces".
 */
export function useHasVoiceChatAccess(): boolean {
  const { user, isAuthenticated } = useAuth();
  if (!isAuthenticated || !user?.email || !ADMIN_EMAIL) return false;
  return user.email === ADMIN_EMAIL;
}
