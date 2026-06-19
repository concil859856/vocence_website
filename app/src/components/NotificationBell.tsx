/**
 * NotificationBell, inbox icon + dropdown panel + detail modal.
 *
 * Two-tier UX, modelled on Linear / Asana / Front:
 *
 *   1. Dropdown panel , opens on the trigger click. Shows a tight
 *      title-only list (no body preview, no busy chips) so the user
 *      can scan 20+ notifications at a glance. Same shape Linear
 *      uses in their inbox sidebar.
 *
 *   2. Detail modal   , opens when a title is clicked. Shows the
 *      full title, body, sender, time, and a "go to" CTA if a link
 *      is attached. Big spacious typography because this view is
 *      the user actually READING the notification, not triaging.
 *
 * Read state flips the instant a notification's modal opens (not on
 * dropdown click) so a stray hover/scroll doesn't burn an unread.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, ChevronRight, Inbox, Loader2, MailWarning, X } from 'lucide-react';
import { dashboardApi, type NotificationItem } from '../services/dashboardApi';
import { useAuth } from '../contexts/AuthContext';
import { useNotificationPolling } from '../hooks/useNotificationPolling';
import { BlogContent } from './BlogContent';


/** Compact bucketed relative time. Matches Linear / Notion / GitHub. */
function formatRelative(iso: string): string {
  const t = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
  if (!isFinite(t)) return '';
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 45) return 'just now';
  if (diffSec < 90) return '1 m ago';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 45) return `${diffMin} m ago`;
  if (diffMin < 90) return '1 h ago';
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD} d ago`;
  const diffMo = Math.floor(diffD / 30);
  if (diffMo < 12) return `${diffMo} mo ago`;
  return `${Math.floor(diffMo / 12)} y ago`;
}

/** Full ISO → "Jun 02, 2026 · 14:32" for the detail-modal byline. */
function formatFull(iso: string): string {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString(undefined, { month: 'short', day: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}


export function NotificationBell() {
  const { isAuthenticated } = useAuth();
  const { unreadCount, refresh: refreshCount } = useNotificationPolling();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeItem, setActiveItem] = useState<NotificationItem | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const loadList = useCallback(async () => {
    // Cookie-only auth: don't gate on a localStorage JWT (always null post-
    // migration). The session cookie travels via credentials:'include'.
    setLoading(true);
    try {
      const res = await dashboardApi.listNotifications(30, 0, '');
      setItems(res.notifications);
    } catch {
      /* leave previous list visible */
    } finally {
      setLoading(false);
    }
  }, []);

  // Open dropdown → fetch list. Cached list stays so a quick reopen
  // is instant; the next fetch refreshes it.
  useEffect(() => {
    if (open) loadList();
  }, [open, loadList]);

  // Click-outside to close the dropdown. The detail modal owns its
  // own overlay so it's not affected by this.
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Escape closes whichever surface is on top: modal first, then dropdown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (activeItem) { setActiveItem(null); return; }
      if (open) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, activeItem]);

  const openDetail = async (n: NotificationItem) => {
    setActiveItem(n);
    setOpen(false);
    // Mark read at modal-open time, not row-hover/scroll, so the
    // unread counter only ticks down on real engagement.
    if (!n.read) {
      try {
        await dashboardApi.markNotificationRead(n.id, '');
        setItems((prev) => prev.map((x) => x.id === n.id ? { ...x, read: true } : x));
        refreshCount();
      } catch { /* swallow */ }
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await dashboardApi.markAllNotificationsRead('');
      setItems((prev) => prev.map((x) => ({ ...x, read: true })));
      refreshCount();
    } catch { /* swallow */ }
  };

  if (!isAuthenticated) return null;

  const displayCount = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="relative flex items-center justify-center w-9 h-9 rounded-full text-white/70 hover:text-white hover:bg-white/[0.08] transition-colors"
          aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
        >
          <Inbox size={18} />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-[16px] text-center tabular-nums">
              {displayCount}
            </span>
          )}
        </button>

        {open && (
          <div
            ref={popoverRef}
            className="
              absolute right-0 mt-2 w-[340px] max-w-[calc(100vw-2rem)]
              rounded-2xl border border-white/10 bg-[#0E1014]/95 backdrop-blur-xl
              shadow-[0_24px_48px_-12px_rgba(0,0,0,0.65),0_0_0_1px_rgba(255,255,255,0.04)]
              z-50 overflow-hidden
              origin-top-right animate-in fade-in zoom-in-95 duration-150
            "
            role="dialog"
            aria-label="Notifications"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-white">Inbox</h3>
                {unreadCount > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#DFFF00]/15 text-[#DFFF00] font-semibold tabular-nums">
                    {unreadCount} new
                  </span>
                )}
              </div>
              {items.some((n) => !n.read) && (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  className="text-[11px] text-white/55 hover:text-white flex items-center gap-1 transition-colors"
                >
                  <Check size={11} /> Mark all read
                </button>
              )}
            </div>

            <div className="max-h-[420px] overflow-y-auto">
              {loading && items.length === 0 ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 size={20} className="animate-spin text-white/40" />
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-white/45">
                  <MailWarning size={22} className="mb-2 opacity-60" />
                  <p className="text-sm">You're all caught up</p>
                </div>
              ) : (
                <ul className="py-1">
                  {items.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => openDetail(n)}
                        className="
                          group/row w-full text-left px-4 py-2.5
                          flex items-center gap-3
                          hover:bg-white/[0.04] transition-colors
                          cursor-pointer
                        "
                      >
                        <span
                          className={
                            'w-1.5 h-1.5 rounded-full shrink-0 ' +
                            (n.read ? 'bg-transparent' : 'bg-[#DFFF00] shadow-[0_0_8px_rgba(223,255,0,0.6)]')
                          }
                          aria-hidden
                        />
                        <p
                          className={
                            'flex-1 min-w-0 text-[13px] leading-tight truncate ' +
                            (n.read ? 'text-white/65 group-hover/row:text-white/85' : 'text-white font-medium')
                          }
                        >
                          {n.title}
                        </p>
                        <span className="shrink-0 text-[10px] text-white/35 tabular-nums whitespace-nowrap">
                          {formatRelative(n.created_at)}
                        </span>
                        <ChevronRight size={13} className="shrink-0 text-white/25 group-hover/row:text-white/55 transition-colors" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      <NotificationDetailModal item={activeItem} onClose={() => setActiveItem(null)} />
    </>
  );
}


/**
 * NotificationDetailModal, expanded view of a single notification.
 *
 * Soft-shadow card centered with backdrop-blur. Big title, generous
 * body typography, byline with sender + full timestamp, and (when
 * the notification has a ``link``) a chartreuse CTA that closes the
 * modal and navigates. Esc-to-close, click-outside-to-close.
 */
function NotificationDetailModal({
  item, onClose,
}: { item: NotificationItem | null; onClose: () => void }) {
  const navigate = useNavigate();
  if (!item) return null;

  const handleGoTo = () => {
    if (item.link) {
      onClose();
      navigate(item.link);
    }
  };

  return (
    // Scroll-safe wrapper mirrors AuthModal: outer ``overflow-y-auto``
    // catches the case where the rendered card outgrows the viewport
    // (long notification body, short laptop viewport, mobile browser
    // chrome eating height). Without it ``flex items-center`` clipped
    // the top half off-screen with no way to reach it.
    <div
      className="
        fixed inset-0 z-[60] overflow-y-auto overscroll-contain
        bg-black/65 backdrop-blur-sm
        animate-in fade-in duration-150
      "
      onClick={onClose}
    >
      <div
        className="
          relative min-h-full w-full flex items-center justify-center p-4
        "
      >
      <div
        className="
          relative w-full max-w-xl rounded-2xl border border-white/10
          bg-gradient-to-b from-[#13161D] to-[#0E1014]
          shadow-[0_32px_64px_-12px_rgba(0,0,0,0.7),0_0_0_1px_rgba(255,255,255,0.04)]
          animate-in zoom-in-95 fade-in duration-200
          overflow-hidden
          max-h-[88vh] flex flex-col
        "
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={item.title}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 z-10 rounded-full p-1.5 text-white/45 hover:text-white bg-black/30 hover:bg-black/50 backdrop-blur-sm transition-colors"
        >
          <X size={16} />
        </button>

        {/* Optional banner image, only renders when the notification
            has an ``image_url`` set. Sits flush at the top inside the
            modal's rounded frame so it reads as part of the card, not
            a floating element. Gentle gradient overlay at the bottom
            so the title-area accent line still shows against busy
            images. ``onError`` hides the whole image block so a 404
            doesn't leave an empty grey rectangle. */}
        {item.image_url && (
          <div className="relative h-44 bg-white/[0.04] border-b border-white/[0.06] overflow-hidden">
            <img
              src={item.image_url}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                const wrap = (e.currentTarget.parentElement as HTMLElement | null);
                if (wrap) wrap.style.display = 'none';
              }}
            />
            <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#13161D] to-transparent pointer-events-none" />
          </div>
        )}

        {/* Top accent stripe, chartreuse line above the title.
            Only shown when there's NO banner image (it'd compete
            with the image visually otherwise). */}
        {!item.image_url && (
          <div className="absolute top-0 left-6 right-6 h-px bg-gradient-to-r from-transparent via-[#DFFF00]/40 to-transparent" />
        )}

        <div className="px-6 pt-6 pb-5 shrink-0">
          <h2 className="text-lg font-semibold text-white leading-snug pr-8">
            {item.title}
          </h2>
          {/* Byline. We never surface the admin's real email, every
              non-system sender becomes "Admin team" so the user never
              sees an internal identity. ``system`` shows as "System"
              for auto-fired notifications (approvals, bonuses). */}
          <p className="mt-1 text-[11px] text-white/45 tabular-nums">
            {item.sender === 'system' ? <>System</> : <>From <span className="text-white/65">Admin team</span></>}
            {' · '}
            {formatFull(item.created_at)}
          </p>
        </div>

        {item.body && (
          <div className="px-6 pb-5 overflow-y-auto">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
              {/* Render markdown, admins write notifications with the
                  same toolbar the blog editor uses, so the user sees
                  rendered headings/bold/links instead of raw ``##``. */}
              <BlogContent
                content={item.body}
                size="compact"
                className="space-y-2.5 text-white/85 break-words"
              />
            </div>
          </div>
        )}

        <div className="px-6 pb-6 pt-2 flex items-center justify-end gap-2 shrink-0 border-t border-white/[0.04]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-white/65 hover:text-white transition-colors"
          >
            Close
          </button>
          {item.link && (
            <button
              type="button"
              onClick={handleGoTo}
              className="
                inline-flex items-center gap-1.5
                rounded-full bg-[#DFFF00] text-[#07080A]
                px-4 py-2 text-sm font-semibold
                hover:brightness-110 transition-all
                shadow-[0_4px_14px_-2px_rgba(223,255,0,0.35)]
              "
            >
              Go to page <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
