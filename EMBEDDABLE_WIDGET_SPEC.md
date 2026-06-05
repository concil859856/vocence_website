# Vocence Embeddable Voice-Agent Widget — Implementation Spec

**Repo to build:** `vocence/widget` (publishes to npm as `@vocence/widget` + CDN)
**Audience:** an implementing engineer/agent with no Vocence-codebase access. Has a browser + Node available; can validate in real browsers.

---

## 1. What this is

A self-contained Web Component (`<vocence-agent>`) that any website can embed with a single `<script>` tag, dropping a working voice + chat widget for one Vocence agent onto the page. Wraps the existing Vocence voicechat WebSocket protocol (see §6), runs entirely in the browser, opens its own audio context, and writes nothing to the host page's CSS / global state.

```html
<!-- One-line embed for the customer -->
<script src="https://widget.vocence.ai/v1/widget.js" defer></script>
<vocence-agent agent-id="ag_abc123"></vocence-agent>
```

That's the entire integration surface from the customer's perspective. Loads ~80 KB gzipped, mounts a floating launcher button bottom-right of the page; clicking opens a chat panel with text + voice modes.

---

## 2. Why this exists

Right now Vocence agents are only usable inside the Vocence Studio UI. ElevenLabs Conversational AI, Vapi, Retell, and OpenAI's GPT widget all ship an embeddable widget — it's how end-customers' end-customers actually use voice agents. Without this, every external integration requires the customer to build their own UI against the WebSocket API. That's a real adoption blocker.

This is the highest-value distribution surface we can build, and it has zero backend dependency once the public-embed auth flow is in place (see §7).

---

## 3. Scope

### In scope
- Single Web Component: `<vocence-agent>`
- Shadow DOM CSS isolation — no class leaks, no host-page conflicts
- Floating launcher button + slide-up chat panel
- Voice mode: mic capture, Silero VAD (browser), audio playback, barge-in
- Text mode: textarea input, sends `text` messages over WS
- Live state UI: connecting / listening / thinking / speaking / error
- Configuration via HTML attributes + a JS API
- Theming via CSS custom properties
- Build artifacts: ES module, IIFE, source maps; published to npm + CDN

### Out of scope
- Server-side rendering (the widget mounts client-side only)
- React / Vue / Svelte component wrappers (provide examples; v1 is plain HTML)
- The public-embed auth flow on the *backend* — that lands on the Vocence side in parallel (see §7)
- Multi-agent UI on one page (one widget = one agent — multi-agent is v2)
- Persistent chat history across page loads (open a panel, talk, close — session is lost)
- Customer's own branding beyond the CSS-variable theming

---

## 4. Public HTML API

### Element + attributes

```html
<vocence-agent
  agent-id="ag_abc123"           required
  server="https://api.vocence.ai" optional (default)
  theme="dark|light|auto"        optional (default "auto")
  position="bottom-right|bottom-left|inline"  optional (default "bottom-right")
  greeting="Hi! How can I help?" optional
  voice-enabled="true"           optional (default "true")
  open-on-load="false"           optional (default "false")
  embed-token="..."              optional (see §7 — required once public-embed lands)
></vocence-agent>
```

### JS API (optional, for custom triggers)

```js
const w = document.querySelector('vocence-agent');
w.open();              // expand the panel
w.close();             // collapse
w.startVoice();        // open + immediately start a voice session
w.sendText("hello");   // open + send a text message
w.addEventListener('vocence:open', e => ...);
w.addEventListener('vocence:close', e => ...);
w.addEventListener('vocence:turn', e => ... /* e.detail = {role, text} */);
w.addEventListener('vocence:error', e => ... /* e.detail = {code, message} */);
```

### CSS custom properties for theming

```css
vocence-agent {
  --voc-accent: #DFFF00;
  --voc-bg: #0B0D10;
  --voc-text: #FFFFFF;
  --voc-bubble-user: #DFFF00;
  --voc-bubble-agent: rgba(255,255,255,0.06);
  --voc-radius: 16px;
  --voc-font: system-ui, -apple-system, sans-serif;
  --voc-z-index: 2147483000;
}
```

All defaults live inside the shadow root. Customer overrides set the variables on the host element.

---

## 5. UI surface (what the customer's end-user sees)

### Floating launcher (always visible)
- 56 × 56 px circular button, accent-coloured
- Mic icon (when voice-enabled) or chat-bubble icon
- Bottom-right of viewport with 24 px margin (configurable via `position` attribute)
- Hovers to lift; click to open panel

### Expanded panel
- 380 × 560 px on desktop; full-width bottom-sheet on mobile (< 640 px viewport)
- Header: agent name (fetched from server on open), close (×), and a small mic/keyboard toggle
- Message list: scroll-bottom, user messages right-aligned, agent left-aligned with avatar
- Composer at bottom:
  - **Voice mode**: big mic button. Click to start; reactive ring when listening; tap again to end the session. Live state ("Listening…", "Thinking…", "Speaking").
  - **Text mode**: textarea, send button, Enter to submit.

### States
- `disconnected` (initial): launcher only
- `idle` (opened, no session): "Start conversation" or text input
- `connecting`: spinner
- `listening` / `recording` / `transcribing` / `thinking` / `speaking`: live state under mic
- `error`: red banner inside panel, kept open

Match the language and behavior of the Vocence Studio AgentChat / AgentCall surfaces (already designed in `STUDIO_FEATURE_SPEC.md` §4.4–4.5 — reference doc available on request from the Vocence team).

---

## 6. WebSocket protocol the widget speaks

The widget connects to the Vocence voicechat backend. This is the existing production protocol — do NOT invent a new one.

### Endpoint
```
WS {server}/api/dashboard/voicechat/session?token={JWT_or_embed_token}&agent_id={agent_id}
```

### Auth options (client picks one)
1. **`token=<JWT>`** — the user is logged into Vocence on the host page. Pass through.
2. **`token=<embed_token>`** (default for embed) — public-embed token; see §7.

### Client → server (JSON text frames)

**Voice input:**
```json
{
  "type": "voice",
  "audio_b64": "<base64 WAV>",
  "mime": "audio/wav",
  "duration_ms": 1234,
  "language": "en"
}
```

**Text input:**
```json
{"type": "text", "text": "hello world"}
```

**Cancel (barge-in):**
```json
{"type": "cancel"}
```

### Server → client

| `type` | Meaning |
|---|---|
| `ready` | Session opened; carries `session_id`, `agent.name`, billing/limits |
| `transcript` | `{text, language}` — the user's STT result |
| `token` | `{text}` — streaming LLM delta for the agent's reply |
| `audio_meta` | `{sentence_id, sample_rate, frame_ms, encoding, channels, is_filler}` — precedes binary frames |
| binary frame | Raw PCM16LE mono audio (no JSON wrapper) |
| `audio_end` | `{sentence_id}` |
| `turn_end` | Agent's reply is fully delivered |
| `cancelled` | Barge-in acknowledged |
| `tool_call_started` / `tool_call_completed` | Tool-call telemetry (UI may show "Searching the web…" chips) |
| `session_timeout` | `{code: "idle_timeout"|"max_duration", message}` |
| `billing_exhausted` | Paid agent ran out of credits |
| `error` | `{code, message}` |

### Audio
- **Receive** raw PCM16LE mono at `audio_meta.sample_rate` (typically 24 kHz), 40 ms frames. Use Web Audio API + AudioWorklet to play with a prebuffer of ~1500 ms cold-start, ~80 ms when `is_filler=true`.
- **Send** WAV-wrapped 16 kHz mono PCM16, base64-encoded in JSON. Capture via `getUserMedia` + Silero VAD (`@ricky0123/vad-web`) for auto-segmentation.

The widget's voice pipeline should match the implementation patterns in the Vocence main app's `useVoiceChat.ts` — including:
- 600 ms post-speak echo-lock window
- Backchannel filter (250 ms grace + 400 ms duration threshold during agent playback)
- Fade-out on barge-in (150 ms gain ramp)

---

## 7. Public-embed authentication (cross-team coordination)

The current voicechat backend requires a user JWT. For embedded use on customer sites, the visitor doesn't have a Vocence account — the *agent owner* is who pays. So the widget needs a different auth mode.

### Required backend change (Vocence team owns this)
Add support for an **embed_token**: a long-lived signed token the agent owner generates from their agent settings page in Vocence Studio. The token:
- Is bound to a specific `agent_id`
- Is bound to an optional allowed-origins list (e.g., `example.com,docs.example.com`)
- Carries rate limits (e.g., max sessions per IP per hour)
- Bills minutes to the agent owner's account
- Is revocable from Studio

The widget just passes it as `?token=<embed_token>` and the backend resolves "anonymous visitor session, billed to agent owner X" from there.

### Until that lands
The widget should accept either a regular JWT (for testing with a logged-in Vocence developer) OR an embed_token. The protocol on the wire is identical — only the token issuance differs.

Document this dependency clearly in the README. The widget should fail loudly if the server returns `{type:"error", code:"auth_required"}` with a helpful message like "embed_token required — generate one from Vocence Studio."

---

## 8. Build & distribution

### Outputs
- `dist/widget.js` — IIFE bundle, ~80 KB gzipped target, includes everything (Silero ONNX, audio worklet inlined)
- `dist/widget.esm.js` — ES module for `npm` consumers
- `dist/widget.d.ts` — TypeScript types
- `dist/widget.js.map` — source map

### Bundle strategy
- Lit (lit-element) for the Web Component — small, no React dep
- Vite or Rollup as the bundler (both fine; Vite preferred for DX)
- Inline the audio worklet source as a string (existing pattern — see `audioPlayer.ts`)
- Inline the Silero ONNX model via `@ricky0123/vad-web` (it does this itself when bundled)
- No external runtime dependencies after build — single self-contained file

### Distribution
- npm: `@vocence/widget` package, semver tagged
- CDN: `https://widget.vocence.ai/v1/widget.js` (latest v1.x) and `https://widget.vocence.ai/v1.2.3/widget.js` (pinned)
- The CDN host config is a Vocence-team task (Cloudflare R2 + custom domain or similar)

### Size budgets
| Artifact | Target gzipped |
|---|---|
| Full widget (with VAD) | ≤ 120 KB |
| Without VAD (text-only mode) | ≤ 25 KB |

If the widget is loaded but voice is disabled (`voice-enabled="false"`), the VAD code should be dynamically imported so text-only users don't pay the ONNX download.

---

## 9. Performance targets

| Metric | Target |
|---|---|
| Time from `<script>` tag → launcher visible | ≤ 200 ms on a 3G connection |
| Time from launcher click → panel rendered | ≤ 50 ms |
| Time from "Start voice" click → WS connected + mic open | ≤ 800 ms |
| Time-to-first-audio after user finishes speaking | matches the backend's `audio_meta` cadence (the widget should not add buffering beyond what's specced) |
| RAM at idle (panel closed) | ≤ 5 MB |
| RAM with active voice session | ≤ 40 MB |
| First Input Delay impact on host page | ≤ 50 ms (use `defer` + lazy work) |

Use Lighthouse + WebPageTest to verify.

---

## 10. Browser support

- Chrome / Edge / Safari / Firefox last 2 versions
- iOS Safari 16+ (`getUserMedia` + AudioWorklet support is solid from 16)
- Android Chrome equivalent
- Graceful degrade on unsupported browsers: show text-only mode + a "voice not supported in this browser" message

---

## 11. Privacy / consent

- The widget MUST NOT call `getUserMedia` until the user clicks the mic. No auto-listen.
- On first voice activation per origin, show a one-line consent line: "Voice mode connects to Vocence to transcribe what you say. Stop anytime."
- The widget MUST NOT set cookies on the host page. Use `sessionStorage` only for the WS session id, scoped to its own origin.
- All audio is sent to the configured `server` only; no third-party analytics calls.

---

## 12. Repo structure

```
widget/
├─ README.md            # quickstart + examples
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ src/
│  ├─ index.ts          # registers <vocence-agent>
│  ├─ component.ts      # the Lit element
│  ├─ panel.ts          # opened-panel UI
│  ├─ launcher.ts       # floating button
│  ├─ session/
│  │  ├─ ws.ts          # WS client
│  │  ├─ player.ts      # streaming PCM audio player (copy patterns from Vocence main app's audioPlayer.ts)
│  │  ├─ recorder.ts    # mic capture
│  │  └─ vad.ts         # Silero wrapper
│  ├─ ui/
│  │  ├─ styles.ts      # shadow-DOM CSS
│  │  ├─ icons.ts       # SVG icons inlined
│  │  └─ state-label.ts
│  └─ proto.ts          # message types from §6
├─ examples/
│  ├─ minimal.html
│  ├─ themed.html       # custom CSS vars
│  ├─ programmatic.html # uses the JS API
│  └─ react-wrapper.tsx
└─ .github/workflows/
   ├─ ci.yml
   └─ release.yml
```

---

## 13. Test plan

### Unit
- Protocol parsing (every server→client `type` correctly dispatched)
- Auth-token URL building
- CSS-variable defaulting

### Integration (Playwright, headless Chrome)
- Mount the widget on a blank page, assert launcher visible
- Click launcher → panel opens
- Send a text message, mock the WS, assert agent bubble appears with streamed tokens
- Mock voice flow: simulated audio frames in, simulated PCM frames out, assert playback worklet receives them
- Origin restriction: mount with `embed-token` that has `allowed_origins=["foo.com"]`, run on `bar.com`, assert error

### Manual / real-browser
- iPhone Safari 16+: full voice flow works (this is the historically-flaky platform)
- Headphones vs speakers: barge-in doesn't self-trigger on speakers (post-speak lock works)
- Slow 3G: launcher still visible within 200 ms

### Size regression
- CI fails if `dist/widget.js` exceeds 120 KB gzipped

---

## 14. Things to confirm with the Vocence team

1. **Embed-token endpoint.** The widget assumes a backend change exists to accept `?token=<embed_token>`. That's a separate dashboard-backend task. Coordinate so neither side ships broken.
2. **CDN host.** `widget.vocence.ai` needs to be set up by Vocence ops. The widget repo doesn't own the CDN — only the npm publish.
3. **The agent name fetch endpoint.** The panel header shows the agent's display name. The widget needs a public, no-auth-required `GET /v1/public/agents/{agent_id}` that returns `{name, avatar_url, status}` for any agent that has a valid embed_token. New endpoint.
4. **Billing model for embedded sessions.** Currently the voicechat protocol bills the *user*. Embed sessions need to bill the *agent owner*. The backend embed_token flow must handle this — call it out as a dependency.
5. **Origin restriction enforcement.** The widget can pass `Origin` in the WS handshake, but the *backend* must validate it against the embed_token's allowed origins. Otherwise anyone can scrape an embed_token and reuse it on their own site.

These five items are all blocking for the *production* embed flow. The widget itself can ship to npm and be tested with a regular JWT token in the meantime.

---

## 15. Definition of done

1. All §9 performance targets pass on Lighthouse desktop + mobile
2. All §13 integration tests pass in CI
3. Examples in `examples/` work end-to-end against a real Vocence dev backend with a JWT token
4. Published to npm as `@vocence/widget@0.1.0`
5. Bundle size ≤ 120 KB gzipped enforced in CI
6. Works on iPhone Safari 16+, Chrome desktop, Firefox desktop in manual smoke
7. README documents: minimal embed, theming, JS API, mobile considerations, the embed_token dependency (with TODO link)

Once green, the Vocence integration side is: the embed_token issuance UI on the agent settings page, the backend endpoint changes (§14 items 1, 3, 4, 5), and the CDN host config. None block the widget from being published to npm.

---

## 16. Quick start (for the implementing engineer)

```bash
# In a fresh widget repo
pnpm create vite . --template lit-ts
pnpm install lit @ricky0123/vad-web
pnpm install -D playwright

# Implement per §4–§7 above

# Build + test locally
pnpm build
pnpm test
pnpm preview

# In examples/minimal.html:
# <script type="module" src="/dist/widget.esm.js"></script>
# <vocence-agent agent-id="ag_test123" server="https://dev.api.vocence.ai"></vocence-agent>
```
