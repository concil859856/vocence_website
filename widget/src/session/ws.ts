/**
 * WebSocket client for the Vocence voicechat protocol.
 *
 * The protocol is documented in ``VOICE_AGENT_PLATFORM_SPEC.md §5``.
 * One WS connection per active conversation; the client handles the
 * connect handshake, message dispatch, automatic reconnect-on-clean-
 * close (for session timeouts), and binary PCM frame forwarding.
 *
 * The widget instantiates one ``VoicechatClient``, attaches event
 * handlers, and calls ``connect()`` when the user opens a session.
 * The client converts the framed wire protocol into typed events the
 * Lit component layer consumes.
 *
 * Design choices:
 *
 *   • One method per outgoing message type. Simpler than a single
 *     ``send(...)`` with a union — typo-safe at call sites.
 *
 *   • Events expose typed payloads, not raw ``MessageEvent``. Lit
 *     components shouldn't care about JSON.parse / try/catch.
 *
 *   • The class is constructor-injected with ``server``, ``token``,
 *     ``agentId`` so the same code path serves both authenticated
 *     dashboard users (JWT) and anonymous embed-token visitors (vet_).
 *     The backend distinguishes the two based on the token prefix.
 */

import type {
  CapabilitiesInfo,
  ChatMessage,
  ClientMessage,
  ServerMessage,
} from '../proto';


export interface VoicechatClientOptions {
  /** Backend origin, e.g. ``https://api.vocence.ai``. The client
   *  flips ``http(s)`` → ``ws(s)`` automatically. */
  server: string;
  /** Either a Vocence JWT (logged-in dev testing) or a ``vet_...``
   *  embed token (production embeds). The backend chooses the auth
   *  path from the prefix. */
  token: string;
  /** Agent id the session targets. When ``token`` is an embed token
   *  the backend overrides this from the token's binding — but the
   *  WS handshake still accepts the field for forward-compat. */
  agentId: string;
  /** Language hint the STT pipeline uses when one's not auto-
   *  detectable from the audio. Optional; ``auto`` is fine. */
  language?: string;
}


/** Event-source-style API: subscribe with ``on('event-name', fn)``,
 *  unsubscribe by calling the returned disposer. Keeps the surface
 *  small (no EventEmitter import) while letting Lit components hook
 *  up + tear down with normal property cleanup. */
type Listener<T> = (payload: T) => void;
type ListenerMap = {
  [K in keyof VoicechatEvents]: Listener<VoicechatEvents[K]>[];
};

export interface VoicechatEvents {
  /** ``open`` fires once the underlying WS is open AND the server has
   *  sent the ``ready`` frame. Carrying the ready payload here means
   *  components don't need to listen for both events separately. */
  open: {
    sessionId: string;
    agentName: string;
    /** Capability flags from the server's ready payload. Absent on
     *  older servers — clients should default to one-shot voice. */
    capabilities?: CapabilitiesInfo;
  };
  /** Each user/agent/system message added or updated. The widget
   *  re-renders its message list off this. */
  message: ChatMessage;
  /** Live caption from the streaming-STT pod (when wired up). The
   *  text is cumulative — replace, don't append. */
  partialTranscript: { text: string };
  /** UI-level state change driven by server events. The Lit
   *  component layer keys its visuals (mic ring, "thinking…" label,
   *  etc.) off this. */
  state:
    | 'connecting'
    | 'listening'
    | 'recording'
    | 'transcribing'
    | 'thinking'
    | 'speaking'
    | 'idle';
  /** Tool-call activity from the agent's LLM. UI shows a small chip
   *  ("Searching the web…") while in flight. */
  toolCall: { id: string; name: string; kind: 'builtin' | 'custom'; status: 'running' | 'done' };
  /** Audio frame arrived from the TTS streamer. The widget forwards
   *  it to the streaming player. ``meta`` precedes a run of binary
   *  frames and tells the player the format. */
  audioMeta: {
    sentenceId: number;
    sampleRate: number;
    frameMs: number;
    isFiller: boolean;
  };
  /** Raw PCM16LE frame. Binary; the WS client unpacks the
   *  ``ArrayBuffer`` directly from the WS event. */
  audioFrame: ArrayBuffer;
  /** End of one sentence's audio stream. Player can drain its queue
   *  to silence after this if no follow-up audio_meta arrives. */
  audioEnd: { sentenceId: number };
  /** WS closed — either user-initiated or remote. ``code`` is the
   *  WebSocket close code; ``reason`` the human-readable string. */
  close: { code: number; reason: string };
  /** Fatal error from the server. Already rendered as a system
   *  message; emit separately so the UI can show a top-level banner. */
  error: { code: string; message: string };
}


export class VocenceWsClient {
  private ws: WebSocket | null = null;
  private readonly listeners: Partial<ListenerMap> = {};
  private connected = false;
  private opts: VoicechatClientOptions;

  constructor(opts: VoicechatClientOptions) {
    this.opts = opts;
  }

  /** Subscribe to one event. Returns a disposer the caller invokes
   *  on cleanup (Lit's ``disconnectedCallback`` for instance). */
  on<K extends keyof VoicechatEvents>(
    name: K,
    fn: Listener<VoicechatEvents[K]>,
  ): () => void {
    const arr = (this.listeners[name] ||= []) as Listener<VoicechatEvents[K]>[];
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  /** Open the WS and start the session. Resolves once the server's
   *  ``ready`` frame has been received and dispatched as ``open``.
   *  Rejects if the WS handshake fails or the server sends an
   *  ``auth_required`` error before ``ready``. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.emit('state', 'connecting');
    const url = buildWsUrl(this.opts.server, this.opts.token, this.opts.agentId);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let opened = false;

      ws.onmessage = (ev) => {
        // Binary frames are raw PCM audio. We forward the
        // ArrayBuffer; the audio player resamples and queues.
        if (typeof ev.data !== 'string') {
          this.emit('audioFrame', ev.data as ArrayBuffer);
          return;
        }
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        // Handshake completes when the first ``ready`` arrives.
        if (!opened && msg.type === 'ready') {
          opened = true;
          this.connected = true;
          this.emit('open', {
            sessionId: msg.session_id,
            agentName: msg.agent.name,
            capabilities: msg.capabilities,
          });
          this.emit('state', 'listening');
          resolve();
          return;
        }
        this.dispatch(msg);
      };
      ws.onopen = () => {
        /* No-op — the protocol's ``ready`` frame from the server is
           the real "connected" signal. */
      };
      ws.onclose = (ev) => {
        this.connected = false;
        this.emit('close', { code: ev.code, reason: ev.reason });
        if (!opened) {
          reject(new Error(`WebSocket closed before ready (code ${ev.code})`));
        }
      };
      ws.onerror = () => {
        if (!opened) reject(new Error('WebSocket connect error'));
      };
    });
  }

  /** Tear down the WS politely. Safe to call multiple times. */
  close(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, 'client close');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  /** Send a captured speech segment to the backend (one-shot voice
   *  mode). Audio is base64-encoded WAV; the backend's batch STT path
   *  expects this shape. Used when the server hasn't advertised the
   *  ``voice_stream`` capability. */
  sendVoice(audioB64: string, mime: string, durationMs: number): void {
    this.sendJson({
      type: 'voice',
      audio_b64: audioB64,
      mime,
      duration_ms: durationMs,
      language: this.opts.language,
    });
  }

  /** Begin a streaming voice turn. Subsequent calls to ``sendPcmFrame``
   *  ship audio to the server's StreamingTurnSession; ``commitStream``
   *  signals end-of-utterance (the server's ensembler may commit on
   *  its own first).
   *
   *  Used only when the server's ready payload advertises
   *  ``capabilities.voice_stream``. */
  startVoiceStream(): void {
    this.sendJson({
      type: 'stream_start',
      language: this.opts.language,
    });
  }

  /** Push a 20–32 ms PCM s16le frame to the server. Pass raw bytes,
   *  not a base64 string — WebSocket binary frames carry it as-is. */
  sendPcmFrame(pcm: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(pcm);
    } catch {
      // The WS state will surface via ``onclose``; nothing to do here.
    }
  }

  /** Tell the server "I've finished speaking" — useful as a hint to
   *  the ensembler. Safe to call even if the ensembler already
   *  committed; the server treats it as a no-op then. */
  commitStream(): void {
    this.sendJson({ type: 'stream_commit' });
  }

  sendText(text: string): void {
    this.sendJson({ type: 'text', text });
  }

  /** Barge-in cancellation. The backend stops the in-flight LLM stream
   *  + TTS and emits ``cancelled`` once the cleanup completes. */
  cancel(): void {
    this.sendJson({ type: 'cancel' });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sendJson(payload: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch {
      // The WS state will surface via ``onclose``; nothing to do here.
    }
  }

  private emit<K extends keyof VoicechatEvents>(
    name: K, payload: VoicechatEvents[K],
  ): void {
    const arr = this.listeners[name];
    if (!arr) return;
    // Iterate a snapshot so handlers that unsubscribe themselves
    // mid-dispatch don't skip their siblings.
    for (const fn of [...(arr as Listener<VoicechatEvents[K]>[])]) {
      try {
        fn(payload);
      } catch (err) {
        // A throwing listener shouldn't break the rest. Best-effort
        // log to the console — the embedder can see what broke.
        // eslint-disable-next-line no-console
        console.error('[vocence-widget] listener error', err);
      }
    }
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.type) {
      case 'ready':
        // Handled in ``onmessage`` for the first ``ready``. A re-ready
        // (server bounced) we ignore — the caller would have already
        // seen ``close``.
        return;
      case 'transcript':
        this.emit('message', {
          id: cryptoId(),
          role: 'user',
          text: msg.text,
        });
        this.emit('state', 'thinking');
        return;
      case 'partial_transcript':
        this.emit('partialTranscript', { text: msg.text });
        return;
      case 'token':
        // Streaming agent text. Up to the consumer to accumulate
        // into one bubble; we just relay each chunk.
        this.emit('message', {
          id: '__streaming__',
          role: 'agent',
          text: msg.text,
          pending: true,
        });
        return;
      case 'audio_meta':
        this.emit('audioMeta', {
          sentenceId: msg.sentence_id,
          sampleRate: msg.sample_rate,
          frameMs: msg.frame_ms,
          isFiller: !!msg.is_filler,
        });
        this.emit('state', 'speaking');
        return;
      case 'audio_end':
        this.emit('audioEnd', { sentenceId: msg.sentence_id });
        return;
      case 'turn_end':
        this.emit('state', 'listening');
        return;
      case 'cancelled':
        // Best-effort signal the previous turn is done. The next
        // user action (record or send) starts a fresh turn.
        this.emit('state', 'listening');
        return;
      case 'tool_call_started':
        this.emit('toolCall', {
          id: msg.id, name: msg.name, kind: msg.kind, status: 'running',
        });
        return;
      case 'tool_call_completed':
        this.emit('toolCall', {
          id: msg.id, name: '', kind: 'builtin', status: 'done',
        });
        return;
      case 'session_timeout':
        this.emit('message', {
          id: cryptoId(),
          role: 'system',
          text: msg.message,
          systemKind: msg.code,
        });
        this.emit('state', 'idle');
        return;
      case 'billing_exhausted':
        this.emit('message', {
          id: cryptoId(),
          role: 'system',
          text: msg.message,
          systemKind: 'billing_exhausted',
        });
        this.emit('state', 'idle');
        return;
      case 'error':
        this.emit('error', { code: msg.code, message: msg.message });
        this.emit('message', {
          id: cryptoId(),
          role: 'system',
          text: `Error: ${msg.message}`,
          systemKind: 'info',
        });
        return;
    }
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWsUrl(server: string, token: string, agentId: string): string {
  // Accept ``https://api.vocence.ai`` or ``wss://api.vocence.ai`` —
  // we always flip http(s) to ws(s) so the embedder can pass whatever
  // shape they had handy.
  const wsOrigin = server
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
    .replace(/\/+$/, '');
  const params = new URLSearchParams({ token, agent_id: agentId });
  return `${wsOrigin}/api/dashboard/voicechat/session?${params.toString()}`;
}

function cryptoId(): string {
  // Browser ``crypto.randomUUID`` is available in every target we
  // support. Fall back to a Math.random ID for the unlikely browsers
  // that don't (Chrome <92 / Safari <15.4).
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2, 11);
  }
}
