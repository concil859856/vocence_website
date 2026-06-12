/**
 * Helper hook: load + play (or play+seek) a call recording in the
 * global StudioPlayerBar.
 *
 * Encapsulates the JSON-presigned-URL fetch so callers don't have
 * to think about authorization: they hand over (agentId, sessionId,
 * track metadata) and the helper:
 *
 *   1. Fetches the presigned R2 URL via cookie-authed JSON endpoint.
 *   2. Builds a Track for the StudioPlayer (title, subtitle, image,
 *      downloadFilename) and calls play() or playAt() on the global
 *      context.
 *
 * Loading + error states are reflected via the returned ``status``
 * so callers can disable buttons / show toasts while in flight.
 */

import { useCallback, useState } from 'react';
import { useStudioPlayer, type Track } from '../../contexts/StudioPlayerContext';
import { agentsApi } from './api';

export interface CallTrackMeta {
  agentId: string;
  sessionId: string;
  /** Shown in the player's title slot. Typically the agent name. */
  title: string;
  /** Shown beneath the title. Typically "X turns · Y minutes ago". */
  subtitle?: string;
  /** Optional explicit image URL. When omitted, the player's
   *  fallback-cover pool picks a deterministic image keyed on
   *  title + src — calls from the same agent end up with a stable
   *  visual identity automatically. */
  image?: string;
  /** Pre-known total duration in seconds. Forwarded to the player
   *  so playAt() can paint the bar at the target offset on the
   *  first frame — without it, a click-to-seek-from-cold flashes
   *  the bar at 0:00 before snapping to the target. Pass
   *  ``call.duration_ms / 1000``. */
  durationSec?: number;
}

type Status = 'idle' | 'loading' | 'error';

export function useCallPlayer(token: string | null) {
  const player = useStudioPlayer();
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  // session_id of whatever the helper most recently asked the player
  // to load. Useful for surfaces that need a "this row is loaded"
  // visual cue without subscribing to the global track URL.
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);

  const buildTrack = useCallback(
    (meta: CallTrackMeta, url: string): Track => ({
      src: url,
      title: meta.title,
      subtitle: meta.subtitle,
      image: meta.image,
      durationHintSec: meta.durationSec,
      // Stable identity so the fallback avatar doesn't reshuffle on
      // every fresh presigned-URL fetch (signed query params differ
      // between plays of the same call). Key on agentId so every
      // call for the SAME agent gets the same gradient — call.id
      // would change the avatar per call which fights the visual
      // "this is my support agent" identity.
      artSeed: `agent-${meta.agentId}`,
      // The download endpoint is its own URL; we don't pass it here
      // because Track.downloadFilename triggers a fetch-based download
      // path in the player that would re-fetch the presigned URL after
      // it expires. The call surfaces render their own Download link
      // pointing at the server endpoint instead.
    }),
    [],
  );

  const play = useCallback(
    async (meta: CallTrackMeta) => {
      if (!token) return;
      setStatus('loading');
      setError(null);
      try {
        const url = await agentsApi.getCallAudioUrl(token, meta.agentId, meta.sessionId);
        player.play(buildTrack(meta, url));
        setLoadedSessionId(meta.sessionId);
        setStatus('idle');
      } catch (err) {
        const msg = (err as Error)?.message ?? 'failed to load recording';
        setError(msg);
        setStatus('error');
      }
    },
    [token, player, buildTrack],
  );

  const playAt = useCallback(
    async (meta: CallTrackMeta, startSec: number) => {
      if (!token) return;
      setStatus('loading');
      setError(null);
      try {
        const url = await agentsApi.getCallAudioUrl(token, meta.agentId, meta.sessionId);
        player.playAt(buildTrack(meta, url), startSec);
        setLoadedSessionId(meta.sessionId);
        setStatus('idle');
      } catch (err) {
        const msg = (err as Error)?.message ?? 'failed to load recording';
        setError(msg);
        setStatus('error');
      }
    },
    [token, player, buildTrack],
  );

  return { play, playAt, status, error, loadedSessionId };
}
