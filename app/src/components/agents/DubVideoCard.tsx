import { Download, Film, Play, Trash2 } from 'lucide-react';
import { ExpiryBadge } from '../ExpiryBadge';
import type { VideoDubHistoryItem } from '../../services/dashboardApi';

/**
 * One dubbed video, as a card.
 *
 * Shared by the inline "Recent dubs" strip and the full-library dialog so the
 * two can never drift — a card that behaves differently depending on where it
 * is rendered is a bug waiting to happen.
 */

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface DubVideoCardProps {
  item: VideoDubHistoryItem;
  /** Human label for the target language, resolved by the caller. */
  languageLabel: string;
  onPlay: (item: VideoDubHistoryItem) => void;
  onDelete: (id: number) => void;
}

export function DubVideoCard({ item, languageLabel, onPlay, onDelete }: DubVideoCardProps) {
  const playable = !!item.video_url && item.status === 'completed';

  return (
    <div className="group overflow-hidden rounded-lg border border-border transition hover:border-primary/40">
      <button
        type="button"
        disabled={!playable}
        onClick={() => playable && onPlay(item)}
        className="relative block aspect-video w-full overflow-hidden bg-black disabled:cursor-not-allowed"
        title={playable ? 'Play' : 'Unavailable'}
      >
        {item.poster_url ? (
          <img
            src={item.poster_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
        ) : item.video_url ? (
          // No stored poster — rows predating the poster feature, or a deploy
          // without ffmpeg. Draw the opening frame from the video itself:
          // metadata-only, so it costs a range request rather than the whole
          // file, and the currentTime nudge forces a frame to paint.
          <video
            src={item.video_url}
            muted
            playsInline
            preload="metadata"
            tabIndex={-1}
            aria-hidden="true"
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              if (el.currentTime === 0) {
                try {
                  el.currentTime = Math.min(0.1, (el.duration || 1) / 2);
                } catch {
                  /* seeking unsupported; the icon fallback is fine */
                }
              }
            }}
            className="pointer-events-none h-full w-full object-cover transition group-hover:scale-[1.02]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground" />
          </span>
        )}

        {playable && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
            <span className="rounded-full bg-white/90 p-3">
              <Play className="h-5 w-5 fill-black text-black" />
            </span>
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] text-white">
          {formatTime(item.duration_sec)}
        </span>
      </button>

      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{languageLabel}</p>
            <p className="truncate text-xs text-muted-foreground">
              {item.source_filename || 'Video'}
            </p>
          </div>
          {item.lipsync && (
            <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
              lip-synced
            </span>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          {/* Dubs are kept permanently, so expires_at is empty and this
              renders nothing. Legacy rows still show their real window. */}
          <ExpiryBadge expiresAt={item.expires_at} expired={item.status !== 'completed'} />
          <div className="flex items-center gap-1">
            {item.video_url && (
              <a
                href={item.video_url}
                download={`vocence-dub-${item.target_language}-${item.id}.mp4`}
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Download"
              >
                <Download className="h-4 w-4" />
              </a>
            )}
            <button
              type="button"
              onClick={() => onDelete(item.id)}
              className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DubVideoCard;
