/**
 * Shadow-DOM scoped styles for the widget.
 *
 * Each CSS-custom-property has a sensible default for a dark theme.
 * Embedders override the variables on the host element to retheme:
 *
 *   vocence-agent {
 *     --voc-accent: #007bff;
 *     --voc-bg: #ffffff;
 *     --voc-text: #111111;
 *   }
 *
 * We deliberately don't reset the customer's CSS — Shadow DOM means
 * none of our styles can leak out, and none of their styles can
 * affect anything inside the shadow root. The host element itself
 * (``<vocence-agent>``) inherits the host page's font and colour by
 * default; that's why we expose ``--voc-font`` for embedders who
 * want it explicitly set.
 *
 * Layout: the launcher floats fixed-position. The panel is fixed too
 * — anchored relative to the launcher position so resizing the
 * viewport doesn't strand it.
 *
 * Mobile: under 640 px viewport, the panel becomes a full-width
 * bottom sheet. Above that, it's a 380 × 560 px card.
 */

import { css } from 'lit';


export const widgetStyles = css`
  :host {
    /* Default theme — overridable from the host page. */
    --voc-accent: #DFFF00;
    --voc-accent-contrast: #07080A;
    --voc-bg: #0B0D10;
    --voc-bg-elevated: rgba(255, 255, 255, 0.04);
    --voc-text: #FFFFFF;
    --voc-text-muted: #A7B0B7;
    --voc-text-dim: #666666;
    --voc-border: rgba(255, 255, 255, 0.1);
    --voc-border-strong: rgba(255, 255, 255, 0.2);
    --voc-bubble-user: var(--voc-accent);
    --voc-bubble-user-text: var(--voc-accent-contrast);
    --voc-bubble-agent: rgba(255, 255, 255, 0.06);
    --voc-bubble-agent-text: var(--voc-text);
    --voc-radius: 16px;
    --voc-radius-small: 10px;
    --voc-font:
      system-ui, -apple-system, 'Segoe UI', Roboto, Oxygen-Sans, Ubuntu,
      Cantarell, 'Helvetica Neue', sans-serif;
    --voc-z-index: 2147483000;
    /* The shadow under floating elements. Soft enough to read on
       light AND dark host pages — we don't know which without a
       runtime check. */
    --voc-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);

    font-family: var(--voc-font);
    color: var(--voc-text);
    line-height: 1.4;
  }

  /* Launcher button — bottom-right by default. */
  .launcher {
    position: fixed;
    bottom: 24px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--voc-accent);
    color: var(--voc-accent-contrast);
    border: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--voc-shadow);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    z-index: var(--voc-z-index);
  }
  .launcher:hover {
    transform: scale(1.05);
    box-shadow: 0 14px 48px rgba(0, 0, 0, 0.5);
  }
  .launcher:active {
    transform: scale(0.96);
  }
  :host([position="bottom-right"]) .launcher,
  :host(:not([position])) .launcher {
    right: 24px;
  }
  :host([position="bottom-left"]) .launcher {
    left: 24px;
  }
  :host([position="inline"]) .launcher {
    position: static;
    box-shadow: none;
  }

  /* Panel container — fixed beside the launcher on desktop, full-
     width bottom sheet on mobile. */
  .panel {
    position: fixed;
    bottom: 92px;
    width: 380px;
    height: 560px;
    max-height: calc(100vh - 100px);
    background: var(--voc-bg);
    border: 1px solid var(--voc-border);
    border-radius: var(--voc-radius);
    box-shadow: var(--voc-shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: var(--voc-z-index);
  }
  :host([position="bottom-right"]) .panel,
  :host(:not([position])) .panel {
    right: 24px;
  }
  :host([position="bottom-left"]) .panel {
    left: 24px;
  }
  @media (max-width: 640px) {
    .panel {
      left: 0 !important;
      right: 0 !important;
      bottom: 0;
      width: 100%;
      height: 75vh;
      border-radius: var(--voc-radius) var(--voc-radius) 0 0;
    }
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--voc-border);
    background: var(--voc-bg-elevated);
  }
  .header .name {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--voc-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .header .state {
    font-size: 11px;
    color: var(--voc-text-muted);
    margin-top: 1px;
    display: block;
  }
  .header .close {
    background: transparent;
    border: none;
    color: var(--voc-text-muted);
    cursor: pointer;
    padding: 6px;
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .header .close:hover {
    color: var(--voc-text);
    background: rgba(255, 255, 255, 0.06);
  }

  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--voc-accent) 0%, #22d3ee 100%);
    color: var(--voc-accent-contrast);
    font-weight: 700;
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  /* Message list */
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .messages::-webkit-scrollbar {
    width: 8px;
  }
  .messages::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
  }
  .empty {
    text-align: center;
    color: var(--voc-text-muted);
    font-size: 13px;
    padding: 24px 12px;
  }
  .bubble {
    max-width: 85%;
    padding: 8px 12px;
    border-radius: 14px;
    font-size: 14px;
    line-height: 1.45;
    word-wrap: break-word;
    white-space: pre-wrap;
  }
  .row {
    display: flex;
  }
  .row.user { justify-content: flex-end; }
  .row.agent { justify-content: flex-start; }
  .row.system { justify-content: center; }
  .row.user .bubble {
    background: var(--voc-bubble-user);
    color: var(--voc-bubble-user-text);
  }
  .row.agent .bubble {
    background: var(--voc-bubble-agent);
    color: var(--voc-bubble-agent-text);
    border: 1px solid var(--voc-border);
  }
  .row.system .bubble {
    background: rgba(255, 191, 0, 0.08);
    color: #ffcb6b;
    border: 1px solid rgba(255, 191, 0, 0.25);
    font-size: 12px;
    max-width: 90%;
    text-align: center;
  }
  .row.system .bubble[data-kind="billing_exhausted"] {
    background: rgba(255, 80, 80, 0.10);
    color: #ff9b9b;
    border-color: rgba(255, 80, 80, 0.30);
  }

  .dots {
    display: inline-flex;
    gap: 4px;
  }
  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
    animation: voc-pulse 1.2s infinite ease-in-out;
  }
  .dots span:nth-child(2) { animation-delay: 0.15s; }
  .dots span:nth-child(3) { animation-delay: 0.30s; }
  @keyframes voc-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* Composer */
  .composer {
    border-top: 1px solid var(--voc-border);
    padding: 10px;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--voc-bg);
  }
  .composer textarea {
    flex: 1;
    resize: none;
    min-height: 36px;
    max-height: 120px;
    padding: 8px 10px;
    border-radius: var(--voc-radius-small);
    border: 1px solid var(--voc-border);
    background: var(--voc-bg-elevated);
    color: var(--voc-text);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.4;
    outline: none;
  }
  .composer textarea:focus {
    border-color: var(--voc-accent);
  }
  .composer textarea::placeholder {
    color: var(--voc-text-dim);
  }
  .composer button {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: none;
    background: var(--voc-bg-elevated);
    color: var(--voc-text);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease;
  }
  .composer button:hover {
    background: rgba(255, 255, 255, 0.10);
  }
  .composer button.mic.active {
    background: var(--voc-accent);
    color: var(--voc-accent-contrast);
  }
  .composer button.send {
    background: var(--voc-accent);
    color: var(--voc-accent-contrast);
  }
  .composer button.send:disabled {
    background: var(--voc-bg-elevated);
    color: var(--voc-text-dim);
    cursor: not-allowed;
  }

  /* Voice mode big button */
  .voice-mode {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 16px;
    border-top: 1px solid var(--voc-border);
  }
  .voice-mode .big-mic {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    border: none;
    background: var(--voc-accent);
    color: var(--voc-accent-contrast);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    transition: transform 0.15s ease;
  }
  .voice-mode .big-mic:hover {
    transform: scale(1.04);
  }
  .voice-mode .big-mic.listening::after {
    content: "";
    position: absolute;
    inset: -6px;
    border: 2px solid var(--voc-accent);
    border-radius: 50%;
    opacity: 0.6;
    animation: voc-ring 1.4s infinite ease-out;
  }
  .voice-mode .big-mic.error {
    background: #ff5a5a;
  }
  @keyframes voc-ring {
    from { transform: scale(1); opacity: 0.6; }
    to { transform: scale(1.4); opacity: 0; }
  }
  .voice-mode .label {
    font-size: 12px;
    color: var(--voc-text-muted);
  }
  .voice-mode .end {
    background: rgba(255, 80, 80, 0.12);
    color: #ffb4b4;
    border: 1px solid rgba(255, 80, 80, 0.30);
    border-radius: 18px;
    padding: 6px 14px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .voice-mode .end:hover {
    background: rgba(255, 80, 80, 0.20);
  }

  /* Live caption above the composer */
  .caption {
    font-size: 12px;
    color: var(--voc-text-muted);
    padding: 6px 12px;
    border-top: 1px solid var(--voc-border);
    background: var(--voc-bg-elevated);
    font-style: italic;
    min-height: 1.5em;
    line-height: 1.3;
  }

  /* Error banner */
  .error-banner {
    background: rgba(255, 80, 80, 0.12);
    color: #ffb4b4;
    border-bottom: 1px solid rgba(255, 80, 80, 0.30);
    padding: 8px 12px;
    font-size: 12px;
  }

  /* Privacy consent line shown once before the first voice activation. */
  .consent {
    background: var(--voc-bg-elevated);
    color: var(--voc-text-muted);
    font-size: 11px;
    padding: 6px 12px;
    border-top: 1px solid var(--voc-border);
    text-align: center;
  }

  /* Mode toggle pill (voice / text) */
  .mode-toggle {
    display: inline-flex;
    background: var(--voc-bg-elevated);
    border: 1px solid var(--voc-border);
    border-radius: 999px;
    padding: 2px;
  }
  .mode-toggle button {
    background: transparent;
    border: none;
    color: var(--voc-text-muted);
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
  }
  .mode-toggle button.active {
    background: var(--voc-accent);
    color: var(--voc-accent-contrast);
  }
`;
