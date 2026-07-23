import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useStudioPlayer } from './StudioPlayerContext';
import { dashboardApi, type JobStatusResponse } from '../services/dashboardApi';

export type JobType = 'tts' | 'stt' | 'clone' | 'voice_design' | 'music' | 'video_dub';

export interface JobResult {
  audioUrl?: string;
  /** Where to navigate when the user clicks "View" on the toast / job row. */
  navigateTo?: string;
  /** Optional history id for deep-links. */
  entityId?: number;
  /** Title for the bottom-player track when "Play" is clicked from the toast. */
  playerTitle?: string;
  playerSubtitle?: string;
  downloadFilename?: string;
}

export interface Job {
  id: string;                  // client-side uuid
  serverJobId?: string;        // backend UUID when this job lives in the queue system
  type: JobType;
  startedAt: number;
  finishedAt?: number;
  label: string;
  status: 'pending' | 'success' | 'error';
  result?: JobResult;
  error?: string;
  /** Server-side phase ("transcribing reference", "cloning voice", etc.), shown as subtitle in pill. */
  phase?: string | null;
  /** 1-based queue position when status is pending; 0 when processing or done. */
  queuePosition?: number;
  staleAfterReload?: boolean;
}

interface TrackServerJobArgs {
  serverJobId: string;
  type: JobType;
  label: string;
  /** Used to build the toast Play / View action when the job completes. */
  toastResult?: Pick<JobResult, 'navigateTo' | 'playerTitle' | 'playerSubtitle' | 'downloadFilename'>;
  /** Optional poll cadence override (ms). Default 2000. */
  pollIntervalMs?: number;
}

interface ContextValue {
  jobs: Job[];
  pendingCount: number;
  pendingByType: Record<JobType, number>;
  hasPending: (type: JobType) => boolean;
  /** Legacy in-process tracker (used by sync flows we haven't migrated yet). */
  startJob(args: { type: JobType; label: string }): {
    id: string;
    finish: (r?: JobResult) => void;
    fail: (msg: string) => void;
  };
  /** Track a backend-queued job: polls /jobs/{id}, fires toast on completion. */
  trackServerJob(args: TrackServerJobArgs): { id: string };
  prune: () => void;
  dismiss: (id: string) => void;
}

const Ctx = createContext<ContextValue | null>(null);

const TYPE_LABEL: Record<JobType, string> = {
  tts: 'TTS',
  stt: 'Transcription',
  clone: 'Voice clone',
  voice_design: 'Voice design',
  music: 'Music',
  video_dub: 'Video dubbing',
};

const STORAGE_KEY = 'vocence_generations_v1';
const KEEP_DONE_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_JOBS = 50;
const DEFAULT_POLL_MS = 2000;

function loadFromStorage(): Job[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - KEEP_DONE_MS;
    const out: Job[] = [];
    for (const j of parsed as Job[]) {
      if (!j || typeof j.id !== 'string') continue;
      if (j.status !== 'pending' && (j.finishedAt ?? 0) < cutoff) continue;
      if (j.status === 'pending' && !j.serverJobId) {
        // Legacy in-process pending job, we lost its fetch handle on reload
        out.push({ ...j, staleAfterReload: true });
      } else {
        // Server-side jobs survive reloads, we can resume polling on mount
        out.push(j);
      }
    }
    return out.slice(0, MAX_JOBS);
  } catch { return []; }
}

function saveToStorage(jobs: Job[]) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(0, MAX_JOBS)));
  } catch { /* ignore */ }
}

export function GenerationsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>(() => loadFromStorage());
  const idCounterRef = useRef(0);
  const pollersRef = useRef<Map<string, () => void>>(new Map()); // local job id → cancel fn
  const player = useStudioPlayer();
  const navigate = useNavigate();

  useEffect(() => { saveToStorage(jobs); }, [jobs]);

  /** Track jobs we've already toasted on, so duplicate poll responses (or any
   *  re-invocation of `applyServerJob` for a final state) never fire the toast twice.
   *  React 18 + StrictMode can run state-updaters multiple times, keeping toast.* OUT
   *  of the `setJobs` updater plus this guard makes the side effect idempotent. */
  const toastedRef = useRef<Set<string>>(new Set());

  const prune = useCallback(() => {
    const cutoff = Date.now() - KEEP_DONE_MS;
    setJobs((prev) => {
      const kept = prev.filter((j) => j.status === 'pending' || (j.finishedAt ?? 0) > cutoff);
      const keptIds = new Set(kept.map((j) => j.id));
      for (const id of toastedRef.current) {
        if (!keptIds.has(id)) toastedRef.current.delete(id);
      }
      return kept;
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    const cancel = pollersRef.current.get(id);
    if (cancel) { cancel(); pollersRef.current.delete(id); }
    toastedRef.current.delete(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  /** Map backend job → context update; returns true if job is now in a final state.
   *  Side effects (toast / player) live OUTSIDE the setJobs updater, updaters must be pure. */
  const applyServerJob = useCallback((localId: string, type: JobType, label: string, server: JobStatusResponse, toastResult?: TrackServerJobArgs['toastResult']): boolean => {
    const phase = server.phase ?? null;
    const queuePosition = server.queue_position ?? 0;

    if (server.status === 'completed') {
      const audioUrl = (server.result?.audio_url as string | undefined) || undefined;
      const result: JobResult = {
        audioUrl,
        navigateTo: toastResult?.navigateTo,
        playerTitle: toastResult?.playerTitle || label,
        playerSubtitle: toastResult?.playerSubtitle || TYPE_LABEL[type],
        downloadFilename: toastResult?.downloadFilename,
        entityId: (server.result?.history_id as number | undefined),
      };
      setJobs((prev) => prev.map((j) =>
        j.id !== localId ? j : { ...j, status: 'success', finishedAt: Date.now(), result, phase: null, queuePosition: 0 }
      ));
      if (!toastedRef.current.has(localId)) {
        toastedRef.current.add(localId);
        const action = result.audioUrl
          ? {
              label: 'Play',
              onClick: () => {
                player.play({
                  src: result.audioUrl!,
                  title: result.playerTitle || label,
                  subtitle: result.playerSubtitle || TYPE_LABEL[type],
                  downloadFilename: result.downloadFilename,
                });
              },
            }
          : result.navigateTo
            ? { label: 'View', onClick: () => navigate(result.navigateTo!) }
            : undefined;
        toast.success(`${TYPE_LABEL[type]} ready`, {
          description: label.length > 80 ? label.slice(0, 77) + '…' : label,
          action,
        });
      }
      return true;
    }

    if (server.status === 'failed' || server.status === 'timeout' || server.status === 'cancelled') {
      const msg = server.error_message || `${TYPE_LABEL[type]} ${server.status}`;
      setJobs((prev) => prev.map((j) =>
        j.id !== localId ? j : { ...j, status: 'error', finishedAt: Date.now(), error: msg, phase: null, queuePosition: 0 }
      ));
      if (!toastedRef.current.has(localId)) {
        toastedRef.current.add(localId);
        toast.error(`${TYPE_LABEL[type]} ${server.status}`, { description: msg });
      }
      return true;
    }

    // pending or processing, update phase + position only
    setJobs((prev) => prev.map((j) => (j.id !== localId ? j : { ...j, phase, queuePosition })));
    return false;
  }, [player, navigate]);

  const trackServerJob = useCallback<ContextValue['trackServerJob']>(({ serverJobId, type, label, toastResult, pollIntervalMs }) => {
    const localId = `g_${Date.now()}_${++idCounterRef.current}`;
    const job: Job = {
      id: localId,
      serverJobId,
      type,
      startedAt: Date.now(),
      label,
      status: 'pending',
      queuePosition: 0,
    };
    setJobs((prev) => [job, ...prev].slice(0, MAX_JOBS));

    const intervalMs = pollIntervalMs ?? DEFAULT_POLL_MS;
    let cancelled = false;
    let timer: number | null = null;

    const poll = async () => {
      if (cancelled) return;
      const token = localStorage.getItem('vocence_token');
      try {
        const status = await dashboardApi.getJob(serverJobId, token);
        const isFinal = applyServerJob(localId, type, label, status, toastResult);
        if (isFinal) {
          cancelled = true;
          pollersRef.current.delete(localId);
          prune();
          return;
        }
      } catch (e) {
        // Transient errors (network blips, 4xx), keep polling. After many failures we give up.
        console.warn('[generations] poll failed', e);
      }
      if (!cancelled) {
        timer = window.setTimeout(poll, intervalMs);
      }
    };

    void poll();

    const cancel = () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
    pollersRef.current.set(localId, cancel);

    return { id: localId };
  }, [applyServerJob, prune]);

  // Resume polling for jobs rehydrated from localStorage that have a serverJobId
  useEffect(() => {
    for (const j of jobs) {
      if (j.status === 'pending' && j.serverJobId && !pollersRef.current.has(j.id)) {
        // Re-attach a poller using the stored serverJobId
        const localId = j.id;
        const intervalMs = DEFAULT_POLL_MS;
        let cancelled = false;
        let timer: number | null = null;
        const poll = async () => {
          if (cancelled) return;
          const token = localStorage.getItem('vocence_token');
          try {
            const status = await dashboardApi.getJob(j.serverJobId!, token);
            const isFinal = applyServerJob(localId, j.type, j.label, status);
            if (isFinal) { cancelled = true; pollersRef.current.delete(localId); return; }
          } catch (e) { console.warn('[generations] resume-poll failed', e); }
          if (!cancelled) timer = window.setTimeout(poll, intervalMs);
        };
        void poll();
        pollersRef.current.set(localId, () => { cancelled = true; if (timer != null) clearTimeout(timer); });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Legacy in-process tracker (still used by un-migrated sync flows) ─────
  const startJob = useCallback<ContextValue['startJob']>(
    ({ type, label }) => {
      const id = `g_${Date.now()}_${++idCounterRef.current}`;
      const job: Job = { id, type, startedAt: Date.now(), label, status: 'pending' };
      setJobs((prev) => [job, ...prev].slice(0, MAX_JOBS));

      const finish = (result?: JobResult) => {
        setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'success', finishedAt: Date.now(), result } : j)));
        const action = result?.audioUrl
          ? { label: 'Play', onClick: () => player.play({ src: result.audioUrl!, title: result.playerTitle || label.slice(0, 80), subtitle: result.playerSubtitle || TYPE_LABEL[type], downloadFilename: result.downloadFilename }) }
          : result?.navigateTo
            ? { label: 'View', onClick: () => navigate(result.navigateTo!) }
            : undefined;
        toast.success(`${TYPE_LABEL[type]} ready`, { description: label.length > 80 ? label.slice(0, 77) + '…' : label, action });
        prune();
      };

      const fail = (msg: string) => {
        setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'error', finishedAt: Date.now(), error: msg } : j)));
        toast.error(`${TYPE_LABEL[type]} failed`, { description: msg });
        prune();
      };

      return { id, finish, fail };
    },
    [prune, player, navigate],
  );

  const value = useMemo<ContextValue>(() => {
    const pending = jobs.filter((j) => j.status === 'pending');
    const pendingByType: Record<JobType, number> = { tts: 0, stt: 0, clone: 0, voice_design: 0, music: 0, video_dub: 0 };
    for (const j of pending) pendingByType[j.type]++;
    return {
      jobs,
      pendingCount: pending.length,
      pendingByType,
      hasPending: (t) => pendingByType[t] > 0,
      startJob,
      trackServerJob,
      prune,
      dismiss,
    };
  }, [jobs, startJob, trackServerJob, prune, dismiss]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGenerations(): ContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGenerations must be used inside <GenerationsProvider>');
  return ctx;
}
