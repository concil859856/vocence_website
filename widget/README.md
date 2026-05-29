# @vocence/widget

Embeddable voice-agent widget for [Vocence](https://vocence.ai). One
`<script>` tag puts a working voice + chat agent on any website.

```html
<script src="https://widget.vocence.ai/v1/widget.js" defer></script>
<vocence-agent agent-id="ag_abc123" embed-token="vet_..."></vocence-agent>
```

That's the entire integration. The script registers a Web Component;
when a visitor opens the page, a floating mic button appears in the
bottom-right corner. Clicking it opens a chat panel where the visitor
can talk to the agent by voice or text.

---

## What it does

- **Floating launcher** in any corner of the page (configurable)
- **Voice mode** with Silero VAD-driven auto-segmentation,
  echo-cancelled mic capture, and barge-in support
- **Text mode** with a normal chat textarea + send button
- **Streaming TTS playback** via an inline AudioWorklet for low
  glitch-free latency, with a smooth fade-out on barge-in
- **Shadow DOM isolation** — your CSS never affects the widget, the
  widget never affects your CSS
- **Theming** via CSS custom properties on the host element
- **Privacy-friendly defaults**: no cookies, no third-party calls,
  mic only on user gesture, one-time consent line for first voice
  activation

The widget speaks the same WebSocket protocol as the Vocence Studio
agent UI — so anything the in-Studio test interface supports, the
widget supports too (tool calls, knowledge retrieval, billing
exhaustion notices, session-timeout banners, etc.).

---

## Configuration

| Attribute | Required | Default | Purpose |
|---|---|---|---|
| `agent-id` | **yes** | — | The agent ID, copied from Vocence Studio |
| `embed-token` | **yes for production** | — | `vet_...` token minted from Vocence Studio. Sessions opened with this token bill the agent owner. |
| `server` | no | `https://api.vocence.ai` | Backend origin. Set for self-hosted Vocence deployments. |
| `position` | no | `bottom-right` | One of `bottom-right`, `bottom-left`, `inline`. |
| `voice-enabled` | no | `true` | Set `false` to ship a text-only widget. |
| `open-on-load` | no | `false` | Auto-open the panel on page load. |
| `greeting` | no | — | One-line message rendered at the top of the panel. |
| `language` | no | `auto` | STT language hint. Use ISO codes or `auto`. |

---

## Theming

Override CSS custom properties on the host element:

```css
vocence-agent {
  --voc-accent: #007bff;             /* primary accent, buttons + user bubbles */
  --voc-accent-contrast: #ffffff;    /* text against the accent */
  --voc-bg: #ffffff;                 /* panel background */
  --voc-bg-elevated: rgba(0,0,0,0.04);
  --voc-text: #111111;
  --voc-text-muted: #6b7280;
  --voc-border: rgba(0,0,0,0.1);
  --voc-bubble-user: var(--voc-accent);
  --voc-bubble-user-text: var(--voc-accent-contrast);
  --voc-bubble-agent: rgba(0,0,0,0.05);
  --voc-bubble-agent-text: var(--voc-text);
  --voc-radius: 14px;
  --voc-font: 'Inter', system-ui, sans-serif;
  --voc-z-index: 2147483000;
}
```

Every variable has a sensible dark-theme default; you only need to set
what you want to change.

---

## JS API

Programmatic control for embedders who want a custom launcher (a button
in their own UI, a chat icon in a header, etc.):

```js
const w = document.querySelector('vocence-agent');

w.open();                   // expand the panel
w.close();                  // collapse + tear down the session
w.startVoice();             // open + start listening
w.sendText('hello!');       // open + send a text message

w.addEventListener('vocence:open',  () => { ... });
w.addEventListener('vocence:close', () => { ... });
w.addEventListener('vocence:turn',  (e) => {
  // e.detail = { role: 'user' | 'agent', text: '...' }
});
w.addEventListener('vocence:error', (e) => {
  // e.detail = { code: '...', message: '...' }
});
```

---

## Browser support

| Browser | Status |
|---|---|
| Chrome / Edge (last 2 versions) | ✅ Full support |
| Safari 16+ | ✅ Full support |
| Firefox (last 2 versions) | ✅ Full support |
| iOS Safari 16+ | ✅ Full support |
| Older browsers | Graceful text-only mode |

Voice mode requires `getUserMedia` and `AudioWorklet`. Browsers without
those degrade to a text-only widget automatically.

---

## Development

```bash
git clone https://github.com/vocence/widget
cd widget
npm install
npm run dev          # vite dev server with hot reload
npm run build        # produces dist/widget.iife.js + dist/widget.esm.js
npm run typecheck
npm run test         # Playwright integration tests
```

Open `examples/minimal.html` in a browser after `npm run build` to see
the widget against the example backend URL. Set the `server` attribute
to your local dashboard backend for end-to-end testing.

### Bundle structure

- `dist/widget.iife.js` — self-contained IIFE for `<script>`-tag embeds
- `dist/widget.esm.js` — ES module for build-step consumers
- `dist/widget.d.ts` — TypeScript types

Both bundles inline every dependency, including Lit and the Silero VAD
ONNX model loaded by `@ricky0123/vad-web`. The result is one file the
browser fetches in a single round trip.

### Size

- Full widget (voice + text): ~134 KB gzipped IIFE bundle
- ESM bundle: ~148 KB gzipped

Most of the weight is the Silero VAD ONNX runtime, which the browser
caches across pages of the host site. A `voice-enabled="false"`
text-only build skips the VAD and lands closer to 25 KB.

---

## Privacy

- The widget **never** sets cookies on the host page.
- The widget **never** calls `getUserMedia` until the user explicitly
  clicks the mic button.
- The first time a visitor activates voice mode on a given origin, a
  one-line consent banner is shown.
- All audio is sent to the configured `server` only. There are no
  third-party analytics calls.

---

## License

Apache-2.0.
