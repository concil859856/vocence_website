import { AlertTriangle, Clock } from 'lucide-react';

/**
 * "Expires in N days" badge for Library items.
 *
 * Generated audio and video are deleted after a retention window, and a
 * lip-synced dub that cost real credits vanishing without warning is the
 * worst-feeling failure in the product — so retention is stated up front
 * rather than discovered.
 *
 * Premium keeps assets permanently and gets no badge at all; showing
 * "expires" to someone whose files don't expire is worse than showing
 * nothing.
 */

/** Below this many days remaining, the badge turns warning-coloured. */
const URGENT_DAYS = 2;

export interface ExpiryBadgeProps {
  /** ISO timestamp. Empty/absent means no known expiry — renders nothing. */
  expiresAt?: string | null;
  /** Already past expiry; the asset is gone. */
  expired?: boolean;
  /** Premium users' assets don't expire. */
  permanent?: boolean;
  className?: string;
}

function daysUntil(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // Ceil so "18 hours left" reads as "1 day", never "0 days".
  return Math.ceil((t - Date.now()) / 86_400_000);
}

export function ExpiryBadge({ expiresAt, expired, permanent, className = '' }: ExpiryBadgeProps) {
  if (permanent) return null;

  if (expired) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground ${className}`}
        title="This file has passed its retention window and is no longer available."
      >
        <Clock className="h-3 w-3" /> Expired
      </span>
    );
  }

  if (!expiresAt) return null;
  const days = daysUntil(expiresAt);
  if (days === null) return null;

  // A non-expired item whose timestamp has passed is a clock-skew or
  // rounding artefact — say "today" rather than a negative number.
  if (days <= 0) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] text-destructive ${className}`}
        title="Download this soon — it is about to be removed."
      >
        <AlertTriangle className="h-3 w-3" /> Expires today
      </span>
    );
  }

  const urgent = days <= URGENT_DAYS;
  const Icon = urgent ? AlertTriangle : Clock;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
        urgent ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'
      } ${className}`}
      title={`Removed on ${new Date(expiresAt).toLocaleDateString()}. Download it before then to keep it.`}
    >
      <Icon className="h-3 w-3" />
      Expires in {days} {days === 1 ? 'day' : 'days'}
    </span>
  );
}

export default ExpiryBadge;
