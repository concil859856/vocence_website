/**
 * useNotificationPolling, polls /notifications/unread-count at a fixed
 * interval (default 30 min, matches the user-requested cadence) and
 * returns the latest unread count.
 *
 * Why 30 min and not real-time:
 *  - Approval-status notifications don't need sub-second delivery.
 *  - A WebSocket push would add infra surface for ~zero UX gain.
 *  - SSE would still need a long-lived connection per session, and
 *    server-side fan-out for broadcast notifications.
 *  - Polling at 30 min is cheap on the backend (one COUNT(*) per
 *    user per hour) and works through every proxy / mobile-radio
 *    sleep cycle without reconnect dances.
 *
 * The hook also exposes a ``refresh()`` to bump the count on demand —
 * the bell dropdown calls it after marking notifications read so the
 * badge stays in sync without waiting for the next tick.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { dashboardApi } from '../services/dashboardApi';

const DEFAULT_POLL_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes

export function useNotificationPolling(intervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
  const { isAuthenticated } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  // Use a ref so a fast re-render (e.g. login → polling restart)
  // doesn't double up the interval.
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setUnreadCount(0);
      return;
    }
    const token = localStorage.getItem('vocence_token');
    if (!token) {
      setUnreadCount(0);
      return;
    }
    try {
      const res = await dashboardApi.getUnreadNotificationCount(token);
      setUnreadCount(res.unread_count);
    } catch {
      // Soft-fail: leave the previous count visible. The next tick
      // will retry. We deliberately don't surface this error, a
      // momentary network blip shouldn't poke the user.
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setUnreadCount(0);
      return;
    }
    // Immediate first fetch so the badge appears within seconds of
    // login, not after a full poll interval.
    refresh();
    timerRef.current = window.setInterval(() => { refresh(); }, intervalMs);
    return () => {
      if (timerRef.current != null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isAuthenticated, intervalMs, refresh]);

  return { unreadCount, refresh };
}
