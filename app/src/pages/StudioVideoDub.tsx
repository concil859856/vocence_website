import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Film, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { VideoPlayerModal } from '../components/VideoPlayerModal';
import { DubLibraryDialog } from '../components/agents/DubLibraryDialog';
import { DubVideoCard } from '../components/agents/DubVideoCard';
import { useAuth } from '../contexts/AuthContext';
import { useGenerations } from '../contexts/GenerationsContext';
import { dashboardApi, type VideoDubHistoryItem } from '../services/dashboardApi';
import {
  estimateVideoDubCredits,
  VIDEO_DUB_LIPSYNC_MAX_DIMENSION,
  VIDEO_DUB_LIPSYNC_MAX_UPLOAD_BYTES,
  VIDEO_DUB_MAX_DURATION_SEC,
  VIDEO_DUB_MAX_LANGUAGES,
  VIDEO_DUB_MAX_UPLOAD_BYTES,
} from '../studio/creditCosts';

const MAX_FILE_MB = VIDEO_DUB_MAX_UPLOAD_BYTES / (1024 * 1024);
const LIPSYNC_MAX_FILE_MB = VIDEO_DUB_LIPSYNC_MAX_UPLOAD_BYTES / (1024 * 1024);
const LIPSYNC_MAX_DIM = VIDEO_DUB_LIPSYNC_MAX_DIMENSION;
/** Shown inline under the composer — enough to confirm a dub landed. */
const RECENT_COUNT = 3;
const ALLOWED_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi']);

interface Language {
  code: string;
  label: string;
  /** False when the lip-sync engine can't serve this language. */
  lipsync: boolean;
}

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Same convention as the other Studio pages — the JWT lives in localStorage
 *  and is read at call time rather than held in React state. */
function getToken(): string | null {
  return localStorage.getItem('vocence_token');
}

/** Read duration client-side so we can quote a price before uploading.
 *  The server re-probes with ffprobe and is the billing authority — this
 *  is only ever a preview of the cost. */
/** Best-effort "does this file have an audio track?" check.
 *
 * There is no standard way to ask. Firefox exposes `mozHasAudio`, Chromium
 * counts decoded audio bytes, and some browsers implement `audioTracks`.
 * Returns `null` when none of them answer — the caller must treat that as
 * "unknown" and stay silent rather than accusing a perfectly good file of
 * being silent. The server re-checks with ffprobe either way; this only
 * exists to fail fast, before the user is charged.
 */
function detectAudio(el: HTMLVideoElement): boolean | null {
  const probe = el as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  if (typeof probe.mozHasAudio === 'boolean') return probe.mozHasAudio;
  if (probe.audioTracks && typeof probe.audioTracks.length === 'number') {
    return probe.audioTracks.length > 0;
  }
  if (typeof probe.webkitAudioDecodedByteCount === 'number') {
    // Only meaningful once decoding has started; 0 at metadata time is
    // inconclusive, so report unknown rather than "no audio".
    return probe.webkitAudioDecodedByteCount > 0 ? true : null;
  }
  return null;
}

function probeVideo(
  file: File,
): Promise<{ duration: number; width: number; height: number; hasAudio: boolean | null }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = el.duration;
      const hasAudio = detectAudio(el);
      URL.revokeObjectURL(url);
      if (!Number.isFinite(d) || d <= 0) reject(new Error("Couldn't read this video's length."));
      else resolve({ duration: d, width: el.videoWidth, height: el.videoHeight, hasAudio });
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read this video. Try MP4, MOV or WebM."));
    };
    el.src = url;
  });
}

export default function StudioVideoDub() {
  const { user, setLocalCredits } = useAuth();
  const generations = useGenerations();

  const [languages, setLanguages] = useState<Language[]>([]);
  const [languagesError, setLanguagesError] = useState<string | null>(null);
  const [lipsyncAvailable, setLipsyncAvailable] = useState(true);
  const [standardAvailable, setStandardAvailable] = useState(true);
  // Free-plan lip-sync length cap (0 = uncapped), and whether this user is
  // exempt. Both come from the server; the client enforces them for fast
  // feedback and /start enforces them authoritatively.
  const [lipsyncFreeMaxSec, setLipsyncFreeMaxSec] = useState(0);
  const [isPremium, setIsPremium] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [targets, setTargets] = useState<string[]>([]);
  const [lipsync, setLipsync] = useState(false);
  const [consent, setConsent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<VideoDubHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  // The inline strip only ever shows the newest few — the composer is the
  // point of this page. The full library opens in a dialog, which owns its
  // own paging.
  const [libraryOpen, setLibraryOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Which dubbed video is open in the player, if any.
  const [playing, setPlaying] = useState<VideoDubHistoryItem | null>(null);

  // ── Load languages + availability ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    dashboardApi
      .getVideoDubLanguages(getToken())
      .then((res) => {
        if (cancelled) return;
        setLanguages(res.languages || []);
        setLipsyncAvailable(res.lipsync_available);
        setStandardAvailable(res.standard_available);
        setLipsyncFreeMaxSec(res.lipsync_free_max_sec ?? 0);
        setIsPremium(!!res.is_premium);
        setLanguagesError(null);
      })
      .catch((e) => {
        // Never fail silently — an empty picker with no explanation is
        // indistinguishable from "still loading" and hides real outages.
        if (cancelled) return;
        setLanguagesError(
          e instanceof Error && e.message
            ? e.message
            : "Couldn't load the language list. Check your connection and refresh.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Paging happens server-side, so an account with hundreds of dubs only ever
  // transfers the page on screen.
  const loadHistory = useCallback(() => {
    const limit = RECENT_COUNT;
    const offset = 0;
    dashboardApi
      .getVideoDubHistory({ limit, offset }, getToken())
      .then((res) => {
        const items = res.items || [];
        setHistory(items);
        // A server that predates the `total` field omits it. Falling back to
        // items.length would report "3 of 3" on a 3-item page and hide the
        // View-all control — the exact thing that would reveal the rest. A
        // full page instead implies at least one more, so the control stays.
        setHistoryTotal(
          typeof res.total === 'number'
            ? res.total
            : offset + items.length + (items.length >= limit ? 1 : 0),
        );
      })
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // A dub runs 20-160s, so the result appears well after submit. Poll while
  // any dub job is in flight and refresh once more on the falling edge, so
  // the finished video shows up without the user reloading the page.
  const pendingDubs = generations.pendingByType.video_dub;
  const prevPendingDubs = useRef(pendingDubs);
  useEffect(() => {
    if (pendingDubs > 0) {
      const id = setInterval(loadHistory, 5000);
      return () => clearInterval(id);
    }
    if (prevPendingDubs.current > 0) loadHistory();
    prevPendingDubs.current = pendingDubs;
  }, [pendingDubs, loadHistory]);

  useEffect(() => {
    prevPendingDubs.current = pendingDubs;
  }, [pendingDubs]);

  // Revoke the object URL when the preview changes or the page unmounts,
  // otherwise each re-selected file leaks its blob for the session.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // ── Price preview ───────────────────────────────────────────────────────
  // Local estimate shows instantly; the server quote replaces it once it
  // lands, so a server-side rate override can never leave the UI quoting a
  // number we don't actually charge.
  const localEstimate = useMemo(
    () => estimateVideoDubCredits(duration, targets.length, lipsync),
    [duration, targets.length, lipsync],
  );
  // The quote is stored against the inputs that produced it, so when those
  // change the stale number stops matching and we fall back to the local
  // estimate automatically — no imperative clearing, no cascading render.
  const quoteKey = `${Math.ceil(duration)}|${targets.join(',')}|${lipsync}`;
  const [quote, setQuote] = useState<{ key: string; credits: number } | null>(null);
  const estimatedCredits = quote?.key === quoteKey ? quote.credits : localEstimate;

  useEffect(() => {
    if (duration <= 0 || targets.length === 0) return;
    let cancelled = false;
    const t = setTimeout(() => {
      dashboardApi
        .quoteVideoDub({ duration_sec: duration, target_languages: targets, lipsync }, getToken())
        .then((q) => { if (!cancelled) setQuote({ key: quoteKey, credits: q.credits }); })
        .catch(() => { /* keep showing the local estimate */ });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [quoteKey, duration, targets, lipsync]);

  const insufficientCredits = !!user && estimatedCredits > 0 && (user.credits ?? 0) < estimatedCredits;
  // A free account can lip-sync only short clips. Blocks the toggle and submit
  // once a longer video is loaded, but never touches standard dubbing.
  const lipsyncCapped =
    !isPremium && lipsyncFreeMaxSec > 0 && duration > lipsyncFreeMaxSec;
  const lipsyncBlocked = !lipsyncAvailable || lipsyncCapped;

  // ── File selection ──────────────────────────────────────────────────────
  const handleFile = useCallback(async (picked: File) => {
    setError(null);

    const ext = picked.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      setError(`Unsupported format. Use ${[...ALLOWED_EXTENSIONS].join(', ').toUpperCase()}.`);
      return;
    }
    if (picked.size > VIDEO_DUB_MAX_UPLOAD_BYTES) {
      setError(`Video is too large (${formatFileSize(picked.size)}). Max ${MAX_FILE_MB} MB.`);
      return;
    }

    let meta: { duration: number; width: number; height: number; hasAudio: boolean | null };
    try {
      meta = await probeVideo(picked);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read this video.");
      return;
    }
    if (meta.duration > VIDEO_DUB_MAX_DURATION_SEC) {
      setError(`Video is ${formatTime(meta.duration)}. Max length is ${formatTime(VIDEO_DUB_MAX_DURATION_SEC)}.`);
      return;
    }
    // Only reject on a definite "no audio" — `null` means the browser can't
    // tell, and the server re-checks with ffprobe before charging anyway.
    if (meta.hasAudio === false) {
      setError(
        'This video has no audio track, so there is nothing to dub. ' +
          'Upload a video that contains speech.',
      );
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(picked);
    setDuration(meta.duration);
    setDims({ width: meta.width, height: meta.height });
    setPreviewUrl(URL.createObjectURL(picked));
    // Loading a clip past the free lip-sync cap silently turns lip-sync off,
    // so the composer never sits in a state /start would reject.
    if (!isPremium && lipsyncFreeMaxSec > 0 && meta.duration > lipsyncFreeMaxSec) {
      setLipsync(false);
    }
  }, [previewUrl]);

  const clearFile = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setDuration(0);
    setDims({ width: 0, height: 0 });
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }, [previewUrl]);

  const supportsTier = useCallback(
    (lang: Language) => (lipsync ? lang.lipsync : true),
    [lipsync],
  );

  /** Turning lip-sync on drops any already-selected language it can't serve,
   *  so the user never submits a selection the server would reject. */
  const handleLipsyncChange = useCallback(
    (next: boolean) => {
      if (next && lipsyncBlocked) return;
      setLipsync(next);
      if (!next) return;
      setTargets((prev) => prev.filter((c) => languages.find((l) => l.code === c)?.lipsync !== false));
    },
    [languages, lipsyncBlocked],
  );

  const toggleLanguage = useCallback((code: string) => {
    setTargets((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code);
      if (prev.length >= VIDEO_DUB_MAX_LANGUAGES) return prev;
      const lang = languages.find((l) => l.code === code);
      if (lang && lipsync && !lang.lipsync) return prev;
      return [...prev, code];
    });
  }, [languages, lipsync]);

  // ── Submit ──────────────────────────────────────────────────────────────
  const canSubmit =
    !!file &&
    duration > 0 &&
    targets.length > 0 &&
    consent &&
    !submitting &&
    !insufficientCredits &&
    (lipsync ? !lipsyncBlocked : standardAvailable) &&
    targets.every((c) => {
      const lang = languages.find((l) => l.code === c);
      return !lang || !lipsync || lang.lipsync;
    });

  const handleSubmit = useCallback(async () => {
    if (!file || !canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const uploaded = await dashboardApi.uploadDirectToR2('video-dub-source', file, getToken());

      const started = await dashboardApi.startVideoDub(
        {
          src_bucket: uploaded.bucket,
          src_key: uploaded.key,
          src_filename: uploaded.filename,
          duration_sec: duration,
          size_bytes: file.size,
          width: dims.width,
          height: dims.height,
          source_language: 'auto',
          target_languages: targets,
          lipsync,
          num_speakers: 1,
          consent_attested: consent,
        },
        getToken(),
      );

      // Optimistic balance update; the poll below reconciles on failure.
      if (user && typeof started.credits_charged === 'number') {
        setLocalCredits((user.credits ?? 0) - started.credits_charged);
      }

      generations.trackServerJob({
        serverJobId: started.job_id,
        type: 'video_dub',
        label: `Dubbing → ${targets.join(', ').toUpperCase()}`,
        toastResult: {
          navigateTo: '/studio/dubbing',
          downloadFilename: `${file.name.replace(/\.[^.]+$/, '')}-dubbed.mp4`,
        },
      });

      clearFile();
      setTargets([]);
      setConsent(false);
      // History refreshes off the job tracker below, not a fixed delay — a dub
      // takes 20-160s, so a timer here would always fire before it finishes.
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start dubbing.';
      setError(msg);
      // Roll the optimistic deduction back — nothing was charged.
      if (user) setLocalCredits(user.credits ?? 0);
    } finally {
      setSubmitting(false);
    }
  }, [file, canSubmit, duration, dims, targets, lipsync, consent, user, setLocalCredits, generations, clearFile]);

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await dashboardApi.deleteVideoDubHistoryItem(id, getToken());
        setHistory((prev) => prev.filter((h) => h.id !== id));
        setHistoryTotal((t) => Math.max(0, t - 1));
      } catch {
        /* leave the row in place; the next refresh reconciles */
      }
    },
    [],
  );

  const labelFor = useCallback(
    (code: string) => languages.find((l) => l.code === code)?.label ?? code.toUpperCase(),
    [languages],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Film className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold">Video Dubbing</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Translate a video into another language while keeping the original speaker's voice.
          Optionally re-render their mouth so it matches the new audio.
          Dubbed videos are yours to keep — they never expire.
        </p>
      </header>

      {/* Upload */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">1. Choose a video</h2>
        {!file ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-10 text-center transition hover:border-primary hover:bg-muted/50"
          >
            <Upload className="h-6 w-6 text-muted-foreground" />
            <span className="text-sm font-medium">Click to upload a video</span>
            <span className="text-xs text-muted-foreground">
              MP4, MOV, WebM, MKV or AVI · up to {MAX_FILE_MB} MB · max {formatTime(VIDEO_DUB_MAX_DURATION_SEC)}
            </span>
          </button>
        ) : null}

        {/* What actually works. Most failures are a silent clip or, with
            lip-sync on, no visible face — both invisible in the file's
            metadata, so they can only be prevented by saying so up front. */}
        {!file && (
          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <h3 className="mb-2 text-xs font-medium">What works best</h3>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li>
                <span className="text-foreground">Clear speech.</span> Dubbing translates
                what it can hear — a silent, music-only or heavily muffled clip can&apos;t be dubbed.
              </li>
              <li>
                <span className="text-foreground">One speaker.</span> Several people talking
                over each other confuses the voice match.
              </li>
              <li>
                <span className="text-foreground">Little background noise.</span> Run noisy
                audio through Noise Remover first for a cleaner result.
              </li>
              <li>
                <span className="text-foreground">For lip-sync:</span> a front-facing shot
                where the speaker&apos;s mouth stays visible, up to {LIPSYNC_MAX_DIM}px on the
                longest side and {LIPSYNC_MAX_FILE_MB} MB. Off-camera narration doesn&apos;t
                need lip-sync at all.
              </li>
            </ul>
            <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
              Limits: {formatTime(VIDEO_DUB_MAX_DURATION_SEC)} · {MAX_FILE_MB} MB · up to{' '}
              {VIDEO_DUB_MAX_LANGUAGES} languages per video. If a language fails, you&apos;re
              refunded for that language automatically.
            </p>
          </div>
        )}

        {file ? (
          <div className="space-y-2 rounded-lg border border-border p-3">
            {previewUrl && (
              // aspect-video reserves the box before metadata loads. Without
              // it the element has no intrinsic height and collapses to just
              // the control strip, which reads as a broken player.
              <div className="relative aspect-video w-full overflow-hidden rounded bg-black">
                <video
                  src={previewUrl}
                  controls
                  preload="metadata"
                  playsInline
                  // A freshly-attached blob paints black until a frame is
                  // decoded. Nudging currentTime forces the opening frame to
                  // render, so the box shows the video's first scene instead
                  // of an empty rectangle — the poster we can't set for a
                  // local file we haven't uploaded yet.
                  onLoadedMetadata={(e) => {
                    const el = e.currentTarget;
                    if (el.currentTime === 0) {
                      try {
                        el.currentTime = Math.min(0.1, (el.duration || 1) / 2);
                      } catch {
                        /* seeking unsupported for this source; black is fine */
                      }
                    }
                  }}
                  className="h-full w-full object-contain"
                />
              </div>
            )}
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="truncate">
                {file.name} · {formatFileSize(file.size)} · {formatTime(duration)}
              </span>
              <button
                type="button"
                onClick={clearFile}
                className="flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          </div>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </section>

      {/* Languages */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">2. Dub into</h2>
          <span className="text-xs text-muted-foreground">
            {targets.length}/{VIDEO_DUB_MAX_LANGUAGES} selected
          </span>
        </div>
        {languagesError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{languagesError}</span>
          </div>
        )}
        {!languagesError && languages.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading languages…
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {languages.map((lang) => {
            const active = targets.includes(lang.code);
            const unsupported = !supportsTier(lang);
            const atLimit = !active && targets.length >= VIDEO_DUB_MAX_LANGUAGES;
            const disabled = unsupported || atLimit;
            return (
              <button
                key={lang.code}
                type="button"
                disabled={disabled}
                title={unsupported ? 'Not available with lip-sync' : undefined}
                onClick={() => toggleLanguage(lang.code)}
                className={[
                  'rounded-full border px-3 py-1.5 text-xs transition',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border hover:border-primary/50',
                  disabled ? 'cursor-not-allowed opacity-40' : '',
                  unsupported ? 'line-through' : '',
                ].join(' ')}
              >
                {active && <Check className="mr-1 inline h-3 w-3" />}
                {lang.label}
              </button>
            );
          })}
        </div>
        {targets.length > 1 && (
          <p className="text-xs text-muted-foreground">
            Each language is dubbed and billed separately.
          </p>
        )}
      </section>

      {/* Lip-sync */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">3. Options</h2>
        <label
          className={[
            'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition',
            lipsync ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
            lipsyncBlocked ? 'cursor-not-allowed opacity-50' : '',
          ].join(' ')}
        >
          <input
            type="checkbox"
            checked={lipsync}
            disabled={lipsyncBlocked}
            onChange={(e) => handleLipsyncChange(e.target.checked)}
            className="mt-0.5"
          />
          <span className="space-y-1">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-primary" />
              Match lip movements
            </span>
            <span className="block text-xs text-muted-foreground">
              Re-renders the speaker's mouth to match the dubbed audio. Best for close-up,
              front-facing shots. Costs more and takes longer.
              {!lipsyncAvailable && ' Currently unavailable.'}
              {lipsyncAvailable && lipsyncCapped &&
                ` Lip-sync is limited to ${lipsyncFreeMaxSec}s on the free plan — this video is ${Math.round(duration)}s. Trim it or upgrade to Premium.`}
            </span>
          </span>
        </label>
      </section>

      {/* Consent — required. We are contractually responsible for confirming
          the uploader holds likeness rights for everyone in the clip. */}
      <section className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-xs text-muted-foreground">
            I confirm I own this video, or have permission from everyone who appears and
            speaks in it, to translate and re-voice them.
          </span>
        </label>
      </section>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Submit */}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
        <div className="text-sm">
          {estimatedCredits > 0 ? (
            <>
              <span className="font-semibold">{estimatedCredits.toLocaleString()} credits</span>
              <span className="text-muted-foreground">
                {' '}· {formatTime(duration)} × {targets.length}{' '}
                {targets.length === 1 ? 'language' : 'languages'}
              </span>
              {insufficientCredits && (
                <span className="block text-xs text-destructive">
                  You have {(user?.credits ?? 0).toLocaleString()} credits.
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Choose a video and language to see the cost.</span>
          )}
        </div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
          {submitting
            ? 'Starting…'
            : estimatedCredits > 0
              ? `Dub video · ${estimatedCredits.toLocaleString()} credits`
              : 'Dub video'}
        </button>
      </section>

      {/* Recent dubs — the newest few only. Everything else lives in the
          library dialog, so a long history can never bury the composer. */}
      {(history.length > 0 || historyTotal > 0) && (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium">
              Recent dubs
              {historyTotal > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {historyTotal}
                </span>
              )}
            </h2>
            {historyTotal > RECENT_COUNT && (
              <button
                type="button"
                onClick={() => setLibraryOpen(true)}
                className="text-xs text-primary hover:underline"
              >
                View all {historyTotal}
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {history.slice(0, RECENT_COUNT).map((item) => (
              <DubVideoCard
                key={item.id}
                item={item}
                languageLabel={labelFor(item.target_language)}
                onPlay={setPlaying}
                onDelete={handleDelete}
              />
            ))}
          </div>
        </section>
      )}

      <DubLibraryDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        languageLabel={labelFor}
        onPlay={setPlaying}
        onDelete={handleDelete}
        refreshKey={historyTotal}
        playerOpen={!!playing}
      />

      <VideoPlayerModal
        open={!!playing}
        onClose={() => setPlaying(null)}
        src={playing?.video_url || ''}
        poster={playing?.poster_url || undefined}
        title={playing ? `${labelFor(playing.target_language)} dub` : 'Dubbed video'}
      />
    </div>
  );
}
