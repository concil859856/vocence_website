/**
 * WebSocket message types — wire shapes the widget exchanges with the
 * Vocence dashboard backend.
 *
 * Mirrors the protocol documented in
 * ``VOICE_AGENT_PLATFORM_SPEC.md §5`` and the existing implementation
 * in ``dashboard-backend/routers/voicechat.py``. Keeping these types
 * separate from the WS client (``session/ws.ts``) makes it easy to
 * grep for what shapes we accept and produce — and the discriminated
 * unions below give us free exhaustiveness checking in switch
 * statements.
 */

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'voice'; audio_b64: string; mime: string; duration_ms: number; language?: string }
  | { type: 'text';  text: string }
  | { type: 'cancel' };


// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export interface AgentInfo {
  id: string;
  name: string;
}

export interface SessionLimits {
  max_duration_sec: number;
  idle_timeout_sec: number;
}

export interface BillingInfo {
  credits_per_min: number;
  increment_sec: number;
  min_charge_sec: number;
}

/** The streaming-STT pod path adds this event type (cumulative partial
 *  transcript). Existing clients can ignore it; the widget renders it
 *  as a live caption. */
export interface PartialTranscriptMsg {
  type: 'partial_transcript';
  text: string;
  audio_ms_consumed?: number;
}

export type ServerMessage =
  | {
      type: 'ready';
      session_id: string;
      agent: AgentInfo;
      session: SessionLimits;
      billing?: BillingInfo;
    }
  | { type: 'transcript'; text: string; language?: string }
  | PartialTranscriptMsg
  | { type: 'token'; text: string }
  | {
      type: 'audio_meta';
      sentence_id: number;
      sample_rate: number;
      frame_ms: number;
      encoding: 'pcm16le';
      channels: 1;
      is_filler?: boolean;
    }
  | { type: 'audio_end'; sentence_id: number }
  | { type: 'turn_end' }
  | { type: 'cancelled' }
  | { type: 'tool_call_started'; id: string; name: string; kind: 'builtin' | 'custom' }
  | { type: 'tool_call_completed'; id: string; result_preview?: string }
  | { type: 'session_timeout'; code: 'idle_timeout' | 'max_duration'; message: string }
  | { type: 'billing_exhausted'; message: string }
  | {
      type: 'error';
      code:
        | 'auth_required'
        | 'origin_not_allowed'
        | 'rate_limited'
        | 'user_not_found'
        | 'agent_not_found'
        | 'llm_not_configured'
        | 'tts_not_configured'
        | 'insufficient_credits'
        | 'stt_busy'
        | 'stt_failed'
        | 'stt_empty'
        | 'bad_request';
      message: string;
    };


/** Locally-tracked widget UI state. Not transmitted — purely internal. */
export type UiState =
  | 'closed'           // panel collapsed; only the launcher is visible
  | 'idle'             // panel open, no session yet
  | 'connecting'       // WS handshake in progress
  | 'listening'        // mic hot, waiting for the user to talk
  | 'recording'        // user is actively speaking
  | 'transcribing'     // user finished, STT in flight
  | 'thinking'         // STT done, LLM streaming
  | 'speaking'         // TTS audio playing
  | 'error';


/** A single chat message rendered in the panel. We keep a flat list
 *  here rather than a tree to match the existing AgentChat
 *  implementation's expectations — the LLM doesn't branch. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  /** True while the message is mid-stream — used by the UI to render
   *  a pulsing dots indicator. */
  pending?: boolean;
  /** For ``system`` messages — gives the UI enough info to render
   *  different colours per reason (timeout vs billing vs info). */
  systemKind?: 'idle_timeout' | 'max_duration' | 'billing_exhausted' | 'info';
}
