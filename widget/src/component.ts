/**
 * ``<vocence-agent>`` — the main Web Component.
 *
 * The host page mounts this once; the component renders the floating
 * launcher and (when opened) the chat panel. All session machinery —
 * WS, audio player, VAD — lives behind the same instance so it
 * survives panel open/close without re-handshaking.
 *
 * Public reactive properties match the HTML attributes documented in
 * the README:
 *
 *   <vocence-agent agent-id="..." embed-token="..."
 *                  server="..." position="bottom-right|inline"
 *                  voice-enabled="true" open-on-load="false">
 *   </vocence-agent>
 *
 * The component dispatches CustomEvents the host page can listen for:
 *   - vocence:open / vocence:close
 *   - vocence:turn   detail = { role, text }
 *   - vocence:error  detail = { code, message }
 */

import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ChatMessage } from './proto';
import { widgetStyles } from './ui/styles';
import {
  iconClose, iconKeyboard, iconMic, iconMicOff, iconSend,
} from './ui/icons';
import { VocenceWsClient } from './session/ws';
import { StreamingAudioPlayer } from './session/player';
import { VadController, arrayBufferToBase64 } from './session/vad';


type Mode = 'voice' | 'text';
type State =
  | 'idle' | 'connecting' | 'listening' | 'recording'
  | 'transcribing' | 'thinking' | 'speaking' | 'error';


@customElement('vocence-agent')
export class VocenceAgentElement extends LitElement {
  static override styles = widgetStyles;

  // -------------------------------------------------------------------------
  // Public attributes / properties (host-page facing)
  // -------------------------------------------------------------------------

  @property({ attribute: 'agent-id' }) agentId = '';
  @property({ attribute: 'embed-token' }) embedToken = '';
  @property() server = 'https://api.vocence.ai';
  @property() position: 'bottom-right' | 'bottom-left' | 'inline' = 'bottom-right';
  @property() greeting = '';
  @property({ attribute: 'voice-enabled', type: Boolean }) voiceEnabled = true;
  @property({ attribute: 'open-on-load', type: Boolean }) openOnLoad = false;
  @property() theme: 'dark' | 'light' | 'auto' = 'auto';
  @property() language = 'auto';

  // -------------------------------------------------------------------------
  // Internal reactive state
  // -------------------------------------------------------------------------

  @state() private isOpen = false;
  @state() private state: State = 'idle';
  @state() private mode: Mode = 'voice';
  @state() private messages: ChatMessage[] = [];
  @state() private partialCaption = '';
  @state() private agentName = 'Agent';
  @state() private errorBanner: string | null = null;
  @state() private textInput = '';

  /** Whether the user has acknowledged the one-time mic-consent line. */
  @state() private consented = false;

  // -------------------------------------------------------------------------
  // Non-reactive session state
  // -------------------------------------------------------------------------

  private ws: VocenceWsClient | null = null;
  private player: StreamingAudioPlayer | null = null;
  private vad: VadController | null = null;
  private streamingAgentMsgId: string | null = null;

  /** Server has a streaming-STT pod online → we send PCM frames over
   *  the WS and let the server-side ensembler decide turn-end. False
   *  on legacy deployments → fall back to one-shot WAV upload. */
  private streamingVoiceEnabled = false;
  /** Set while an in-flight streaming turn is open on the WS.
   *  Prevents stream_commit from firing twice if the user re-clicks. */
  private streamTurnOpen = false;

  /** Once the launcher is hovered/touched we treat the user as having
   *  expressed intent to interact. AudioContext won't start outside
   *  of this gesture — Safari is strict about it. */
  override connectedCallback(): void {
    super.connectedCallback();
    if (this.openOnLoad) this.isOpen = true;
    this.fetchAgentName();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardownSession();
  }

  /** Read the public agent metadata endpoint to populate the panel
   *  header. The endpoint returns 404 if no non-revoked embed token
   *  exists for the agent — we silently fall back to "Agent" in that
   *  case so the widget still renders. */
  private async fetchAgentName(): Promise<void> {
    if (!this.agentId) return;
    try {
      const r = await fetch(
        `${this.server.replace(/\/+$/, '')}/api/dashboard/public/agents/${encodeURIComponent(this.agentId)}`,
      );
      if (!r.ok) return;
      const body = (await r.json()) as { name?: string };
      if (body?.name) this.agentName = body.name;
    } catch {
      // Network error — keep the default name.
    }
  }

  // -------------------------------------------------------------------------
  // Public JS API (.open() / .close() / .startVoice() / .sendText())
  // -------------------------------------------------------------------------

  open(): void {
    this.isOpen = true;
    this.dispatchCustomEvent('open', {});
  }

  close(): void {
    this.isOpen = false;
    this.teardownSession();
    this.dispatchCustomEvent('close', {});
  }

  async startVoice(): Promise<void> {
    this.mode = 'voice';
    this.isOpen = true;
    await this.ensureSession();
    await this.startListening();
  }

  async sendText(text: string): Promise<void> {
    this.isOpen = true;
    this.mode = 'text';
    await this.ensureSession();
    if (!this.ws) return;
    this.appendUserMessage(text);
    this.ws.sendText(text);
    this.state = 'thinking';
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  private async ensureSession(): Promise<void> {
    if (this.ws) return;
    if (!this.agentId) {
      this.showError('agent-id attribute is required');
      return;
    }
    if (!this.embedToken && !this.server.includes('localhost')) {
      // For dev against localhost without a token, the dashboard
      // will reject — but a clearer message saves the embedder
      // debugging time.
      this.showError('embed-token attribute is required for production embeds');
      return;
    }
    this.state = 'connecting';
    const ws = new VocenceWsClient({
      server: this.server,
      token: this.embedToken,
      agentId: this.agentId,
      language: this.language,
    });
    this.ws = ws;
    this.attachWsHandlers(ws);
    try {
      await ws.connect();
    } catch (err) {
      this.showError(`Could not connect: ${(err as Error).message}`);
      this.ws = null;
      return;
    }
    if (this.greeting) {
      this.appendSystemMessage(this.greeting, 'info');
    }
  }

  private attachWsHandlers(ws: VocenceWsClient): void {
    ws.on('open', ({ agentName, capabilities }) => {
      this.agentName = agentName || this.agentName;
      // Latch the streaming-voice capability for the rest of the
      // session. We don't dynamically resample mid-session if a pod
      // goes offline — the existing turn just falls back via the
      // server-side ensembler timeout.
      this.streamingVoiceEnabled = !!capabilities?.voice_stream;
      this.state = 'idle';
    });
    ws.on('state', (s) => { this.state = s as State; });
    ws.on('message', (m) => this.handleIncomingMessage(m));
    ws.on('partialTranscript', ({ text }) => {
      this.partialCaption = text;
    });
    ws.on('audioMeta', async ({ isFiller }) => {
      // Ensure the player is up before frames start arriving.
      await this.ensurePlayer();
      if (isFiller) this.player?.setFillerPrebuffer();
      else this.player?.setDefaultPrebuffer();
    });
    ws.on('audioFrame', (buf) => {
      this.player?.push(buf);
    });
    ws.on('audioEnd', () => {
      // No-op for now — turn_end handles the state transition.
    });
    ws.on('toolCall', () => {
      // We could render a chip here ("Searching the web…"). For v1
      // we leave it out to keep the bundle small; can re-add when
      // we have the icon set sorted.
    });
    ws.on('error', ({ code, message }) => {
      this.showError(`${code}: ${message}`);
      this.dispatchCustomEvent('error', { code, message });
    });
    ws.on('close', () => {
      this.state = 'idle';
      this.streamingAgentMsgId = null;
    });
  }

  private handleIncomingMessage(m: ChatMessage): void {
    if (m.role === 'user') {
      // Server-side transcript finalised — replace the pending user
      // bubble (if any) or append fresh.
      this.replacePendingUserOrAppend(m.text);
      this.partialCaption = '';
      this.dispatchCustomEvent('turn', { role: 'user', text: m.text });
      return;
    }
    if (m.role === 'agent') {
      this.appendOrUpdateAgentMessage(m.text);
      if (!m.pending) {
        this.dispatchCustomEvent('turn', { role: 'agent', text: m.text });
      }
      return;
    }
    if (m.role === 'system') {
      this.appendSystemMessage(m.text, m.systemKind ?? 'info');
    }
  }

  private async ensurePlayer(): Promise<void> {
    if (this.player) return;
    this.player = new StreamingAudioPlayer({
      onIdle: () => {
        if (this.state === 'speaking') this.state = 'listening';
      },
    });
    try {
      await this.player.init();
    } catch (err) {
      this.showError(`Audio init failed: ${(err as Error).message}`);
    }
  }

  private async startListening(): Promise<void> {
    if (this.vad) return;
    await this.ensurePlayer();
    if (!this.ws) {
      this.showError('Not connected');
      return;
    }
    try {
      const useStream = this.streamingVoiceEnabled;
      this.vad = new VadController(
        {
          onSpeechStart: () => {
            // Barge-in: if the agent is talking, flush playback and
            // cancel the in-flight turn so the user's new speech
            // isn't talked over.
            if (this.state === 'speaking' || this.state === 'thinking') {
              this.player?.flush();
              this.ws?.cancel();
              this.streamTurnOpen = false;
            }
            this.state = 'recording';
            if (useStream && !this.streamTurnOpen) {
              this.ws?.startVoiceStream();
              this.streamTurnOpen = true;
            }
          },
          onSpeechEnd: ({ wavBytes, durationMs }) => {
            if (useStream) {
              // Server-side ensembler usually commits on its own
              // already; sending stream_commit is a hint, not a
              // requirement. Then we just wait for the transcript
              // event to flip into ``thinking``.
              if (this.streamTurnOpen) {
                this.ws?.commitStream();
                this.streamTurnOpen = false;
              }
              this.state = 'transcribing';
              return;
            }
            // Legacy one-shot path: encode the buffered WAV and ship.
            const b64 = arrayBufferToBase64(wavBytes);
            this.ws?.sendVoice(b64, 'audio/wav', durationMs);
            this.state = 'transcribing';
          },
          onPcmFrame: useStream
            ? (pcm: Uint8Array) => {
                if (!this.streamTurnOpen) {
                  // We haven't opened a turn yet — open it now (e.g.
                  // the very first frame arrives before VAD's
                  // ``onSpeechStart`` fires).
                  this.ws?.startVoiceStream();
                  this.streamTurnOpen = true;
                }
                this.ws?.sendPcmFrame(pcm);
              }
            : undefined,
          onError: (err) => {
            this.showError(`Mic error: ${err.message}`);
            this.state = 'error';
          },
        },
        {
          endSilenceMs: 450,
          minSpeechMs: 250,
          mode: useStream ? 'stream' : 'segment',
        },
      );
      await this.vad.start();
      this.consented = true;
      this.state = 'listening';
    } catch (err) {
      this.showError(`Mic permission denied: ${(err as Error).message}`);
      this.state = 'error';
    }
  }

  private stopListening(): void {
    this.vad?.destroy();
    this.vad = null;
    if (this.state === 'listening' || this.state === 'recording') {
      this.state = 'idle';
    }
  }

  private teardownSession(): void {
    this.vad?.destroy();
    this.vad = null;
    void this.player?.close();
    this.player = null;
    this.ws?.close();
    this.ws = null;
    this.state = 'idle';
    this.partialCaption = '';
    this.streamingAgentMsgId = null;
  }

  // -------------------------------------------------------------------------
  // Message-list mutations
  // -------------------------------------------------------------------------

  private appendUserMessage(text: string): void {
    const msg: ChatMessage = { id: makeId(), role: 'user', text };
    this.messages = [...this.messages, msg];
  }

  private replacePendingUserOrAppend(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user' && last.pending) {
      this.messages = [
        ...this.messages.slice(0, -1),
        { ...last, text, pending: false },
      ];
    } else {
      this.appendUserMessage(text);
    }
  }

  private appendOrUpdateAgentMessage(deltaText: string): void {
    if (this.streamingAgentMsgId) {
      this.messages = this.messages.map((m) =>
        m.id === this.streamingAgentMsgId
          ? { ...m, text: m.text + deltaText }
          : m
      );
      return;
    }
    const id = makeId();
    this.streamingAgentMsgId = id;
    this.messages = [
      ...this.messages,
      { id, role: 'agent', text: deltaText, pending: true },
    ];
  }

  private appendSystemMessage(
    text: string,
    kind: 'idle_timeout' | 'max_duration' | 'billing_exhausted' | 'info',
  ): void {
    this.messages = [
      ...this.messages,
      { id: makeId(), role: 'system', text, systemKind: kind },
    ];
  }

  // -------------------------------------------------------------------------
  // Event helpers
  // -------------------------------------------------------------------------

  private dispatchCustomEvent(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(`vocence:${name}`, {
      detail, bubbles: true, composed: true,
    }));
  }

  private showError(msg: string): void {
    this.errorBanner = msg;
    window.setTimeout(() => { this.errorBanner = null; }, 4000);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render() {
    return html`
      ${!this.isOpen ? this.renderLauncher() : nothing}
      ${this.isOpen ? this.renderPanel() : nothing}
    `;
  }

  private renderLauncher() {
    return html`
      <button class="launcher" @click=${() => this.open()} aria-label="Open chat">
        ${this.voiceEnabled ? iconMic : iconKeyboard}
      </button>
    `;
  }

  private renderPanel() {
    return html`
      <div class="panel" role="dialog" aria-label="Voice agent">
        <div class="header">
          <span class="avatar">${initials(this.agentName)}</span>
          <div class="name">
            ${this.agentName}
            <span class="state">${stateLabel(this.state)}</span>
          </div>
          ${this.voiceEnabled ? html`
            <div class="mode-toggle" role="tablist">
              <button class=${this.mode === 'voice' ? 'active' : ''}
                      @click=${() => this.switchToVoice()} type="button">Voice</button>
              <button class=${this.mode === 'text' ? 'active' : ''}
                      @click=${() => this.switchToText()} type="button">Text</button>
            </div>
          ` : nothing}
          <button class="close" @click=${() => this.close()} aria-label="Close">
            ${iconClose}
          </button>
        </div>

        ${this.errorBanner ? html`<div class="error-banner">${this.errorBanner}</div>` : nothing}

        <div class="messages">
          ${this.messages.length === 0 ? html`
            <div class="empty">
              ${this.voiceEnabled
                ? 'Tap the mic and start talking.'
                : 'Type a message to start.'}
            </div>
          ` : nothing}
          ${this.messages.map((m) => this.renderMessage(m))}
        </div>

        ${this.partialCaption ? html`
          <div class="caption">${this.partialCaption}</div>
        ` : nothing}

        ${this.mode === 'voice' && this.voiceEnabled
          ? this.renderVoiceComposer()
          : this.renderTextComposer()}
      </div>
    `;
  }

  private renderMessage(m: ChatMessage) {
    const kindAttr = m.systemKind ? { 'data-kind': m.systemKind } : {};
    return html`
      <div class="row ${m.role}">
        <div class="bubble" ?data-kind=${m.systemKind} ...=${kindAttr}>
          ${m.pending && !m.text ? html`
            <span class="dots"><span></span><span></span><span></span></span>
          ` : m.text}
        </div>
      </div>
    `;
  }

  private renderVoiceComposer() {
    const listening = this.state === 'listening' || this.state === 'recording';
    return html`
      <div class="voice-mode">
        <button
          class=${`big-mic ${listening ? 'listening' : ''} ${this.state === 'error' ? 'error' : ''}`}
          @click=${() => listening ? this.stopListening() : this.startListening()}
          aria-label=${listening ? 'Stop listening' : 'Start listening'}
        >
          ${listening ? iconMic : iconMicOff}
        </button>
        <span class="label">${stateLabel(this.state)}</span>
        ${this.state === 'listening' || this.state === 'recording'
          || this.state === 'thinking' || this.state === 'speaking' ? html`
          <button class="end" @click=${() => this.close()} type="button">
            End session
          </button>
        ` : nothing}
        ${!this.consented ? html`
          <div class="consent">
            Voice mode connects to Vocence to transcribe what you say. Stop anytime.
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderTextComposer() {
    const disabled =
      this.state === 'connecting' || this.state === 'thinking'
      || !this.textInput.trim();
    return html`
      <form class="composer" @submit=${(e: Event) => { e.preventDefault(); void this.submitText(); }}>
        ${this.voiceEnabled ? html`
          <button type="button" class="mic" aria-label="Voice mode"
                  @click=${() => this.switchToVoice()}>${iconMic}</button>
        ` : nothing}
        <textarea
          .value=${this.textInput}
          @input=${(e: Event) => { this.textInput = (e.target as HTMLTextAreaElement).value; }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void this.submitText();
            }
          }}
          placeholder="Type a message…"
          rows="1"
        ></textarea>
        <button class="send" type="submit" ?disabled=${disabled} aria-label="Send">
          ${iconSend}
        </button>
      </form>
    `;
  }

  private async submitText(): Promise<void> {
    const t = this.textInput.trim();
    if (!t) return;
    this.textInput = '';
    await this.sendText(t);
  }

  private async switchToVoice(): Promise<void> {
    this.mode = 'voice';
    await this.ensureSession();
    await this.startListening();
  }

  private switchToText(): void {
    this.mode = 'text';
    this.stopListening();
  }
}


function initials(name: string): string {
  return name
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => (p[0] ?? '').toUpperCase())
    .join('') || 'A';
}


function stateLabel(s: State): string {
  switch (s) {
    case 'idle': return 'Ready';
    case 'connecting': return 'Connecting…';
    case 'listening': return 'Listening…';
    case 'recording': return 'Hearing you';
    case 'transcribing': return 'Transcribing…';
    case 'thinking': return 'Thinking…';
    case 'speaking': return 'Speaking';
    case 'error': return 'Error';
  }
}


function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2, 11);
  }
}


// Augment the global HTMLElementTagNameMap so consumers writing
// TypeScript get type-safe ``querySelector('vocence-agent')`` results.
declare global {
  interface HTMLElementTagNameMap {
    'vocence-agent': VocenceAgentElement;
  }
}
