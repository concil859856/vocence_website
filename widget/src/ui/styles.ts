/**
 * Shadow-DOM scoped styles for the widget — modern, clean redesign.
 *
 * Every visual is driven by CSS custom properties with sensible dark-theme
 * defaults. Embedders retheme by setting the variables on the host element:
 *
 *   vocence-agent {
 *     --voc-accent: #6366f1;
 *     --voc-bg: #ffffff;
 *     --voc-text: #111111;
 *   }
 *
 * Shadow DOM fully isolates these styles — nothing leaks in or out. A
 * ``theme="light"`` attribute (or ``theme="auto"`` + the OS preference)
 * switches the neutral palette; the accent stays whatever the embedder sets.
 */

import { css } from 'lit';


export const widgetStyles = css`
  :host {
    /* ---- Accent (brand) — override per embedder ---- */
    --voc-accent: #6366f1;
    --voc-accent-2: #8b5cf6;
    --voc-accent-contrast: #ffffff;
    --voc-accent-soft: color-mix(in srgb, var(--voc-accent) 16%, transparent);

    /* ---- Neutral palette (dark default) ---- */
    --voc-bg: #0b0c10;
    --voc-surface: #14161c;
    --voc-surface-2: rgba(255, 255, 255, 0.045);
    --voc-elevated: rgba(255, 255, 255, 0.06);
    --voc-text: #f4f5f7;
    --voc-text-muted: #9aa2b1;
    --voc-text-dim: #5f6672;
    --voc-border: rgba(255, 255, 255, 0.08);
    --voc-border-strong: rgba(255, 255, 255, 0.14);

    /* ---- Message bubbles ---- */
    --voc-bubble-user-text: var(--voc-accent-contrast);
    --voc-bubble-agent: rgba(255, 255, 255, 0.055);
    --voc-bubble-agent-text: var(--voc-text);

    /* ---- Shape & motion ---- */
    --voc-radius: 20px;
    --voc-radius-md: 14px;
    --voc-radius-sm: 10px;
    --voc-font:
      'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue',
      sans-serif;
    --voc-z-index: 2147483000;
    --voc-shadow: 0 12px 40px -8px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3);
    --voc-shadow-launch: 0 8px 24px -4px color-mix(in srgb, var(--voc-accent) 45%, transparent), 0 4px 12px rgba(0,0,0,0.3);
    --voc-ok: #34d399;
    --voc-warn: #fbbf24;
    --voc-danger: #f87171;

    font-family: var(--voc-font);
    color: var(--voc-text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  /* Light theme — explicit, or auto + OS preference. */
  :host([theme="light"]) { --voc-light: 1; }
  @media (prefers-color-scheme: light) { :host([theme="auto"]) { --voc-light: 1; } }
  :host([theme="light"]), :host([theme="auto"]) {
    --voc-bg: #ffffff;
    --voc-surface: #f7f8fa;
    --voc-surface-2: rgba(0, 0, 0, 0.025);
    --voc-elevated: rgba(0, 0, 0, 0.04);
    --voc-text: #0f1117;
    --voc-text-muted: #5b6472;
    --voc-text-dim: #98a1b0;
    --voc-border: rgba(0, 0, 0, 0.08);
    --voc-border-strong: rgba(0, 0, 0, 0.14);
    --voc-bubble-agent: rgba(0, 0, 0, 0.045);
    --voc-shadow: 0 12px 40px -8px rgba(16, 24, 40, 0.16), 0 2px 8px rgba(16, 24, 40, 0.08);
  }

  *, *::before, *::after { box-sizing: border-box; }
  button { font-family: inherit; }

  /* ============================ Launcher ============================ */
  .launcher {
    position: fixed;
    bottom: 24px;
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: linear-gradient(140deg, var(--voc-accent), var(--voc-accent-2));
    color: var(--voc-accent-contrast);
    border: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--voc-shadow-launch);
    transition: transform 0.2s cubic-bezier(.2,.9,.3,1.2), box-shadow 0.2s ease;
    z-index: var(--voc-z-index);
    animation: voc-pop 0.32s cubic-bezier(.2,.9,.3,1.2) both;
  }
  .launcher svg { width: 26px; height: 26px; }
  .launcher:hover { transform: translateY(-2px) scale(1.04); }
  .launcher:active { transform: scale(0.95); }
  :host([position="bottom-right"]) .launcher,
  :host(:not([position])) .launcher { right: 24px; }
  :host([position="bottom-left"]) .launcher { left: 24px; }
  :host([position="inline"]) .launcher { position: static; box-shadow: none; }
  @keyframes voc-pop { from { transform: scale(0); opacity: 0; } to { transform: scale(1); opacity: 1; } }

  /* ============================= Panel ============================= */
  .panel {
    position: fixed;
    bottom: 96px;
    width: 384px;
    height: 580px;
    max-height: calc(100vh - 120px);
    background: var(--voc-bg);
    border: 1px solid var(--voc-border);
    border-radius: var(--voc-radius);
    box-shadow: var(--voc-shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: var(--voc-z-index);
    animation: voc-rise 0.26s cubic-bezier(.2,.8,.2,1) both;
  }
  @keyframes voc-rise {
    from { opacity: 0; transform: translateY(14px) scale(.985); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  :host([position="bottom-right"]) .panel,
  :host(:not([position])) .panel { right: 24px; }
  :host([position="bottom-left"]) .panel { left: 24px; }
  :host([position="inline"]) .panel {
    position: static; width: 100%; height: 560px; bottom: auto;
    animation: none;
  }
  @media (max-width: 640px) {
    .panel {
      left: 0 !important; right: 0 !important; bottom: 0;
      width: 100%; height: 82vh; max-height: 82vh;
      border-radius: var(--voc-radius) var(--voc-radius) 0 0;
      border-bottom: none;
    }
  }

  /* ============================= Header ============================ */
  .header {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 13px 14px 13px 14px;
    border-bottom: 1px solid var(--voc-border);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--voc-accent) 7%, transparent), transparent),
      var(--voc-surface);
    backdrop-filter: blur(8px);
  }
  .avatar {
    position: relative;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: linear-gradient(140deg, var(--voc-accent), var(--voc-accent-2));
    color: var(--voc-accent-contrast);
    font-weight: 700;
    font-size: 14px;
    letter-spacing: .02em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 2px 10px -2px color-mix(in srgb, var(--voc-accent) 50%, transparent);
  }
  .header .name {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .header .name > .title {
    font-size: 14.5px;
    font-weight: 650;
    color: var(--voc-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    letter-spacing: -0.01em;
  }
  .header .state {
    font-size: 11.5px;
    color: var(--voc-text-muted);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .header .state::before {
    content: "";
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--voc-text-dim);
    flex-shrink: 0;
  }
  .panel[data-state="idle"] .state::before { background: var(--voc-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--voc-ok) 22%, transparent); }
  .panel[data-state="listening"] .state::before,
  .panel[data-state="recording"] .state::before { background: var(--voc-accent); animation: voc-blink 1.1s infinite; }
  .panel[data-state="thinking"] .state::before,
  .panel[data-state="transcribing"] .state::before { background: var(--voc-warn); animation: voc-blink 1.1s infinite; }
  .panel[data-state="speaking"] .state::before { background: var(--voc-accent); }
  .panel[data-state="error"] .state::before { background: var(--voc-danger); }
  @keyframes voc-blink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

  .header .close {
    background: transparent;
    border: none;
    color: var(--voc-text-muted);
    cursor: pointer;
    width: 32px; height: 32px;
    border-radius: 9px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background .15s ease, color .15s ease;
    flex-shrink: 0;
  }
  .header .close svg { width: 18px; height: 18px; }
  .header .close:hover { color: var(--voc-text); background: var(--voc-elevated); }

  /* Mode toggle pill (Voice / Text) */
  .mode-toggle {
    display: inline-flex;
    background: var(--voc-surface-2);
    border: 1px solid var(--voc-border);
    border-radius: 999px;
    padding: 3px;
    flex-shrink: 0;
  }
  .mode-toggle button {
    background: transparent;
    border: none;
    color: var(--voc-text-muted);
    padding: 5px 12px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 550;
    transition: color .15s ease, background .2s ease;
  }
  .mode-toggle button:hover { color: var(--voc-text); }
  .mode-toggle button.active {
    background: var(--voc-accent);
    color: var(--voc-accent-contrast);
    box-shadow: 0 1px 6px -1px color-mix(in srgb, var(--voc-accent) 55%, transparent);
  }

  /* ========================== Message list ======================== */
  .messages {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    scroll-behavior: smooth;
    scrollbar-width: thin;
    scrollbar-color: var(--voc-border-strong) transparent;
  }
  .messages::-webkit-scrollbar { width: 7px; }
  .messages::-webkit-scrollbar-track { background: transparent; }
  .messages::-webkit-scrollbar-thumb { background: var(--voc-border-strong); border-radius: 99px; }
  .messages::-webkit-scrollbar-thumb:hover { background: var(--voc-text-dim); }

  .empty {
    margin: auto;
    text-align: center;
    color: var(--voc-text-muted);
    font-size: 13.5px;
    padding: 24px 16px;
    max-width: 240px;
  }

  .row { display: flex; animation: voc-msg-in 0.22s ease both; }
  @keyframes voc-msg-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .row.user { justify-content: flex-end; }
  .row.agent { justify-content: flex-start; }
  .row.system { justify-content: center; }

  .bubble {
    max-width: 84%;
    padding: 9px 13px;
    font-size: 14px;
    line-height: 1.5;
    word-wrap: break-word;
    white-space: pre-wrap;
    border-radius: 17px;
  }
  .row.user .bubble {
    background: linear-gradient(135deg, var(--voc-accent), var(--voc-accent-2));
    color: var(--voc-bubble-user-text);
    border-bottom-right-radius: 6px;
    box-shadow: 0 2px 10px -3px color-mix(in srgb, var(--voc-accent) 45%, transparent);
  }
  .row.agent .bubble {
    background: var(--voc-bubble-agent);
    color: var(--voc-bubble-agent-text);
    border: 1px solid var(--voc-border);
    border-bottom-left-radius: 6px;
  }
  .row.system .bubble {
    background: color-mix(in srgb, var(--voc-warn) 10%, transparent);
    color: var(--voc-warn);
    border: 1px solid color-mix(in srgb, var(--voc-warn) 28%, transparent);
    font-size: 12px;
    max-width: 92%;
    text-align: center;
    border-radius: 12px;
    padding: 7px 12px;
  }
  .row.system .bubble[data-kind="billing_exhausted"] {
    background: color-mix(in srgb, var(--voc-danger) 12%, transparent);
    color: var(--voc-danger);
    border-color: color-mix(in srgb, var(--voc-danger) 30%, transparent);
  }

  /* Typing indicator */
  .dots { display: inline-flex; gap: 4px; padding: 2px 0; }
  .dots span {
    width: 7px; height: 7px; border-radius: 50%;
    background: currentColor; opacity: .5;
    animation: voc-typing 1.3s infinite ease-in-out;
  }
  .dots span:nth-child(2) { animation-delay: .18s; }
  .dots span:nth-child(3) { animation-delay: .36s; }
  @keyframes voc-typing {
    0%, 70%, 100% { opacity: .3; transform: translateY(0) scale(.85); }
    35% { opacity: 1; transform: translateY(-3px) scale(1); }
  }

  /* Live caption (partial transcript) */
  .caption {
    font-size: 12.5px;
    color: var(--voc-text-muted);
    padding: 8px 14px;
    border-top: 1px solid var(--voc-border);
    background: var(--voc-surface-2);
    min-height: 1.6em;
    line-height: 1.4;
  }
  .caption::before { content: "“"; opacity: .5; }
  .caption::after { content: "”"; opacity: .5; }

  /* Error banner */
  .error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: color-mix(in srgb, var(--voc-danger) 12%, transparent);
    color: var(--voc-danger);
    border-bottom: 1px solid color-mix(in srgb, var(--voc-danger) 28%, transparent);
    padding: 9px 14px;
    font-size: 12.5px;
    font-weight: 500;
  }

  /* =========================== Text composer ====================== */
  .composer {
    border-top: 1px solid var(--voc-border);
    padding: 12px;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--voc-bg);
  }
  .composer .input-wrap {
    flex: 1;
    display: flex;
    align-items: flex-end;
    gap: 6px;
    background: var(--voc-surface-2);
    border: 1.5px solid var(--voc-border);
    border-radius: var(--voc-radius-md);
    padding: 3px 3px 3px 6px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  .composer .input-wrap:focus-within {
    border-color: var(--voc-accent);
    box-shadow: 0 0 0 3px var(--voc-accent-soft);
  }
  .composer textarea {
    flex: 1;
    resize: none;
    min-height: 32px;
    max-height: 120px;
    padding: 7px 6px;
    border: none;
    background: transparent;
    color: var(--voc-text);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.45;
    outline: none;
  }
  .composer textarea::placeholder { color: var(--voc-text-dim); }
  .composer .mic {
    width: 36px; height: 36px;
    border-radius: 10px;
    border: none;
    background: transparent;
    color: var(--voc-text-muted);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background .15s ease, color .15s ease;
  }
  .composer .mic svg { width: 19px; height: 19px; }
  .composer .mic:hover { background: var(--voc-elevated); color: var(--voc-text); }
  .composer .send {
    width: 38px; height: 38px;
    border-radius: 11px;
    border: none;
    background: linear-gradient(140deg, var(--voc-accent), var(--voc-accent-2));
    color: var(--voc-accent-contrast);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform .15s ease, opacity .15s ease;
    box-shadow: 0 2px 10px -2px color-mix(in srgb, var(--voc-accent) 50%, transparent);
  }
  .composer .send svg { width: 18px; height: 18px; }
  .composer .send:not(:disabled):hover { transform: translateY(-1px) scale(1.04); }
  .composer .send:not(:disabled):active { transform: scale(.95); }
  .composer .send:disabled {
    background: var(--voc-elevated);
    color: var(--voc-text-dim);
    cursor: not-allowed;
    box-shadow: none;
  }

  /* =========================== Voice composer ===================== */
  .voice-mode {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    padding: 22px 16px 20px;
    border-top: 1px solid var(--voc-border);
    background: var(--voc-bg);
  }
  .voice-mode .big-mic {
    width: 72px; height: 72px;
    border-radius: 50%;
    border: none;
    background: linear-gradient(140deg, var(--voc-accent), var(--voc-accent-2));
    color: var(--voc-accent-contrast);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    transition: transform .18s cubic-bezier(.2,.9,.3,1.2);
    box-shadow: 0 6px 22px -4px color-mix(in srgb, var(--voc-accent) 55%, transparent);
  }
  .voice-mode .big-mic svg { width: 30px; height: 30px; }
  .voice-mode .big-mic:hover { transform: scale(1.05); }
  .voice-mode .big-mic:active { transform: scale(.96); }
  .voice-mode .big-mic.listening {
    animation: voc-glow 2s infinite ease-in-out;
  }
  .voice-mode .big-mic.listening::before,
  .voice-mode .big-mic.listening::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid var(--voc-accent);
    animation: voc-ring 1.8s infinite ease-out;
  }
  .voice-mode .big-mic.listening::after { animation-delay: .9s; }
  .voice-mode .big-mic.error {
    background: linear-gradient(140deg, var(--voc-danger), #dc2626);
    box-shadow: 0 6px 22px -4px color-mix(in srgb, var(--voc-danger) 55%, transparent);
  }
  @keyframes voc-ring {
    from { transform: scale(1); opacity: .7; }
    to { transform: scale(1.7); opacity: 0; }
  }
  @keyframes voc-glow {
    0%,100% { box-shadow: 0 6px 22px -4px color-mix(in srgb, var(--voc-accent) 55%, transparent); }
    50% { box-shadow: 0 6px 30px 0 color-mix(in srgb, var(--voc-accent) 70%, transparent); }
  }
  .voice-mode .label {
    font-size: 13px;
    font-weight: 550;
    color: var(--voc-text);
  }
  .voice-mode .end {
    background: color-mix(in srgb, var(--voc-danger) 12%, transparent);
    color: var(--voc-danger);
    border: 1px solid color-mix(in srgb, var(--voc-danger) 28%, transparent);
    border-radius: 999px;
    padding: 7px 16px;
    font-size: 12.5px;
    font-weight: 550;
    cursor: pointer;
    transition: background .15s ease;
  }
  .voice-mode .end:hover { background: color-mix(in srgb, var(--voc-danger) 20%, transparent); }
  .voice-mode .consent {
    color: var(--voc-text-dim);
    font-size: 11.5px;
    text-align: center;
    line-height: 1.4;
    max-width: 260px;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
  }
`;
