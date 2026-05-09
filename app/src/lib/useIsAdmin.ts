import { useAuth } from '../contexts/AuthContext';
import { ADMIN_EMAIL } from '../config';

export function useIsAdmin(): boolean {
  const { user, isAuthenticated } = useAuth();
  return isAuthenticated && !!ADMIN_EMAIL && user?.email === ADMIN_EMAIL;
}
