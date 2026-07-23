import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { DubVideoCard } from './DubVideoCard';
import { dashboardApi, type VideoDubHistoryItem } from '../../services/dashboardApi';

/**
 * Full dubbed-video library, as a large dialog.
 *
 * Paging is server-side: an account with hundreds of dubs only ever transfers
 * the page on screen, along with its poster URLs. Fetching everything and
 * slicing on the client would degrade badly now that dubbing is available on
 * every plan tier.
 */

/** Five across at the dialog's full 1512px width, three rows — a page fills
 *  the grid without turning the dialog into a long scroll. */
export const LIBRARY_PAGE_SIZE = 15;

export interface DubLibraryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Resolves a language code to its display name. */
  languageLabel: (code: string) => string;
  onPlay: (item: VideoDubHistoryItem) => void;
  /** Deletes upstream; the dialog refetches the current page afterwards. */
  onDelete: (id: number) => Promise<void> | void;
  /** Bumped by the parent when something changed outside the dialog. */
  refreshKey?: number;
  /**
   * True while a video player is open above this dialog.
   *
   * The player portals to document.body, so it sits outside this dialog's DOM
   * subtree and Radix counts every click in it — including its close button —
   * as an outside interaction. Without this guard, closing the player also
   * dismisses the library and dumps the user back on the dubbing page.
   */
  playerOpen?: boolean;
}

export function DubLibraryDialog({
  open,
  onClose,
  languageLabel,
  onPlay,
  onDelete,
  refreshKey = 0,
  playerOpen = false,
}: DubLibraryDialogProps) {
  // One state object holding the page that was actually fetched. Loading is
  // then *derived* — `data.page !== page` means a request is in flight — so
  // nothing sets state synchronously inside an effect, which would cascade a
  // render on every open.
  const [data, setData] = useState<{
    page: number;
    items: VideoDubHistoryItem[];
    total: number;
  } | null>(null);
  const [page, setPage] = useState(0);
  const [nonce, setNonce] = useState(0);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE));
  // Clamped rather than corrected in an effect: deleting the last rows can
  // leave `page` past the end, and an out-of-range page should simply resolve
  // to the last real one instead of triggering a fix-up render.
  const safePage = Math.min(page, pageCount - 1);
  const items = data?.items ?? [];
  const loading = data === null || data.page !== safePage;

  const load = useCallback(() => {
    if (!open) return;
    const offset = safePage * LIBRARY_PAGE_SIZE;
    dashboardApi
      .getVideoDubHistory(
        { limit: LIBRARY_PAGE_SIZE, offset },
        localStorage.getItem('vocence_token'),
      )
      .then((res) => {
        const rows = res.items || [];
        setData({
          page: safePage,
          items: rows,
          // A server predating the `total` field omits it. Guessing
          // `rows.length` would report a single page and hide the pager, so a
          // full page instead implies at least one more.
          total:
            typeof res.total === 'number'
              ? res.total
              : offset + rows.length + (rows.length >= LIBRARY_PAGE_SIZE ? 1 : 0),
        });
      })
      .catch(() => setData({ page: safePage, items: [], total: 0 }));
  }, [open, safePage, refreshKey, nonce]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(
    async (id: number) => {
      await onDelete(id);
      // Removing the last row on a page steps back; `safePage` would clamp it
      // anyway, but moving explicitly keeps the pager's highlight correct.
      if (items.length === 1 && safePage > 0) setPage(safePage - 1);
      else setNonce((n) => n + 1);
    },
    [onDelete, items.length, safePage],
  );

  // Keep the pager compact: near-neighbours plus the first and last page.
  const visiblePages = Array.from({ length: pageCount }, (_, i) => i).filter(
    (i) => Math.abs(i - safePage) <= 2 || i === 0 || i === pageCount - 1,
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {/* NOTE the `sm:` prefix on max-width. DialogContent's base class list
          ends with `sm:max-w-lg`, and a responsive variant beats an unprefixed
          utility at any viewport >= 640px — so a plain `max-w-*` here is
          silently ignored and the dialog stays small. 1512px matches
          VideoPlayerModal so the two feel like the same surface. */}
      <DialogContent
        // While the player is open it owns dismissal: Escape and outside
        // clicks should close the video and return here, not tear down both
        // layers at once.
        onInteractOutside={(e) => {
          if (playerOpen) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (playerOpen) e.preventDefault();
        }}
        className="flex max-h-[90vh] w-[96vw] max-w-[1512px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1512px]"
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base">
            Your dubbed videos
            {total > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">{total}</span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* The grid scrolls, the header and pager stay put. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading && items.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              No dubbed videos yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {items.map((item) => (
                <DubVideoCard
                  key={item.id}
                  item={item}
                  languageLabel={languageLabel(item.target_language)}
                  onPlay={onPlay}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>

        {total > LIBRARY_PAGE_SIZE && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-3">
            <span className="text-xs text-muted-foreground">
              {safePage * LIBRARY_PAGE_SIZE + 1}–{Math.min((safePage + 1) * LIBRARY_PAGE_SIZE, total)} of{' '}
              {total}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={safePage === 0 || loading}
                onClick={() => setPage(Math.max(0, safePage - 1))}
                className="rounded border border-border px-2 py-1 text-xs transition hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              {visiblePages.map((i, idx, arr) => (
                <span key={i} className="flex items-center">
                  {idx > 0 && arr[idx - 1] !== i - 1 && (
                    <span className="px-1 text-xs text-muted-foreground">…</span>
                  )}
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => setPage(i)}
                    className={`min-w-[28px] rounded border px-2 py-1 text-xs transition ${
                      i === safePage
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    {i + 1}
                  </button>
                </span>
              ))}
              <button
                type="button"
                disabled={(safePage + 1) * LIBRARY_PAGE_SIZE >= total || loading}
                onClick={() => setPage(safePage + 1)}
                className="rounded border border-border px-2 py-1 text-xs transition hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default DubLibraryDialog;
