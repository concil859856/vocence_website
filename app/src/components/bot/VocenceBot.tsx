/**
 * Floating Vocence assistant bot, only mounted on Studio routes.
 *
 *   ┌────────────┐
 *   │ chat panel │  (slides up when expanded)
 *   └────────────┘
 *                 (●)  ← circular launcher, draggable, position persisted
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Mic, Send, Square, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useVoiceChat } from '../../lib/voicechat/useVoiceChat';
import { renderMessage } from '../../lib/voicechat/renderInline';
import { ToolCallChip } from '../../lib/voicechat/ToolCallChip';
import { useArchitectOpen } from '../../lib/uiOverlay';
import { useHasVoiceChatAccess } from '../../lib/voicechatAccess';

const STORAGE_TOKEN_KEY = 'vocence_token';
const STORAGE_POS_KEY = 'vocence_bot_launcher_pos';

// 56 was the original; 72 ≈ 1.3×, bumped on user request so her face reads more clearly.
const LAUNCHER_SIZE = 72;
const VIEWPORT_PADDING = 16;
// "Slightly raised" default: sits 88 px above the bottom edge instead of 24 px.
const DEFAULT_BOTTOM_OFFSET = 88;
const DEFAULT_RIGHT_OFFSET = 24;
// How many pixels the cursor must move during a press before it's a drag,
// not a click. Anything under this threshold is treated as a tap.
const DRAG_THRESHOLD_PX = 5;

// Position is persisted as an "anchor": the closest viewport corner plus
// pixel offsets from that corner. That way the launcher returns to the same
// visual spot when the window is resized, clamping by absolute (x, y) lets
// a temporary squeeze permanently shift the button.
type AnchorSide = 'tl' | 'tr' | 'bl' | 'br';
interface Anchor {
  side: AnchorSide;
  dx: number; // distance from the chosen horizontal edge
  dy: number; // distance from the chosen vertical edge
}

function defaultAnchor(): Anchor {
  return { side: 'br', dx: DEFAULT_RIGHT_OFFSET, dy: DEFAULT_BOTTOM_OFFSET };
}

function anchorFromPos(p: { x: number; y: number }): Anchor {
  if (typeof window === 'undefined') return defaultAnchor();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cx = p.x + LAUNCHER_SIZE / 2;
  const cy = p.y + LAUNCHER_SIZE / 2;
  const right = cx > w / 2;
  const bottom = cy > h / 2;
  const side = ((bottom ? 'b' : 't') + (right ? 'r' : 'l')) as AnchorSide;
  const dx = Math.max(VIEWPORT_PADDING, right ? w - LAUNCHER_SIZE - p.x : p.x);
  const dy = Math.max(VIEWPORT_PADDING, bottom ? h - LAUNCHER_SIZE - p.y : p.y);
  return { side, dx, dy };
}

function posFromAnchor(a: Anchor): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  const w = window.innerWidth;
  const h = window.innerHeight;
  const right = a.side[1] === 'r';
  const bottom = a.side[0] === 'b';
  const x = right ? w - LAUNCHER_SIZE - a.dx : a.dx;
  const y = bottom ? h - LAUNCHER_SIZE - a.dy : a.dy;
  return clampToViewport({ x, y });
}

function clampToViewport(p: { x: number; y: number }): { x: number; y: number } {
  if (typeof window === 'undefined') return p;
  const maxX = window.innerWidth - LAUNCHER_SIZE - VIEWPORT_PADDING;
  const maxY = window.innerHeight - LAUNCHER_SIZE - VIEWPORT_PADDING;
  return {
    x: Math.max(VIEWPORT_PADDING, Math.min(maxX, p.x)),
    y: Math.max(VIEWPORT_PADDING, Math.min(maxY, p.y)),
  };
}

function loadStoredAnchor(): Anchor {
  if (typeof window === 'undefined') return defaultAnchor();
  try {
    const saved = localStorage.getItem(STORAGE_POS_KEY);
    if (!saved) return defaultAnchor();
    const parsed = JSON.parse(saved);
    // New format: { side, dx, dy }
    if (parsed && typeof parsed.side === 'string' && typeof parsed.dx === 'number' && typeof parsed.dy === 'number') {
      const valid: AnchorSide[] = ['tl', 'tr', 'bl', 'br'];
      if (valid.includes(parsed.side)) return parsed as Anchor;
    }
    // Legacy format: { x, y } absolute pixels, convert to anchor against the current viewport.
    if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return anchorFromPos(clampToViewport(parsed));
    }
  } catch { /* ignore */ }
  return defaultAnchor();
}

// Routes where the floating assistant should NOT appear. Dashboard + admin
// pages are dense, internal/data-heavy surfaces where the launcher would
// just get in the way.
const HIDDEN_ROUTE_PREFIXES = ['/dashboard', '/admin'];

export function VocenceBot() {
  const { user } = useAuth();
  const hasAccess = useHasVoiceChatAccess();
  const architectOpen = useArchitectOpen();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_TOKEN_KEY));
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Launcher position, drag-and-drop with cursor, persisted per-browser.
  // ``anchorRef`` is the source of truth (corner + offsets); ``pos`` is the
  // derived absolute (x, y) used for rendering. On resize we re-derive pos
  // from the anchor so the launcher returns to its original visual spot.
  const anchorRef = useRef<Anchor>(loadStoredAnchor());
  const [pos, setPos] = useState<{ x: number; y: number }>(() => posFromAnchor(anchorRef.current));
  const [dragging, setDragging] = useState(false);

  // Drag state lives in a ref so handlers don't recreate on every render.
  // `moved` flips true once the cursor crosses the drag threshold; we use it
  // in onPointerUp to decide between "click → toggle" and "drag → save pos".
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);

  // Recompute pos from the persisted anchor on every resize. This keeps the
  // launcher pinned to the same visual corner-offset rather than drifting
  // each time the viewport temporarily shrinks.
  useEffect(() => {
    const onResize = () => setPos(posFromAnchor(anchorRef.current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Track token across logins/logouts (AuthContext doesn't expose it directly)
  useEffect(() => {
    setToken(localStorage.getItem(STORAGE_TOKEN_KEY));
  }, [user?.id]);

  // Always-on voice: one tap on Speak starts a hands-free session, VAD
  // detects each turn, submits it, plays the reply, and reopens the mic.
  // The user never has to press a "stop talking" button mid-conversation.
  const { state, messages, micLevel, error, listening, startListening, stopListening, sendText, cancel, reset } = useVoiceChat({
    enabled: open && !!token && !!user,
    authToken: token,
    alwaysOn: true,
  });

  // External entry-point: any UI on the site can open Logos via
  // ``window.dispatchEvent(new CustomEvent('vocence:open-logos', { detail: { autoStart?: boolean } }))``.
  // The Studio home spotlight card uses this to make its "Call" button
  // feel like a real call, opens the panel AND starts the mic so the
  // user doesn't have to click twice. Must sit AFTER useVoiceChat so
  // ``startListening`` is in scope when the effect captures it.
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<{ autoStart?: boolean }>).detail;
      setOpen(true);
      if (detail?.autoStart) {
        // Defer one tick so the panel mounts + the useVoiceChat hook
        // sees ``enabled=true`` before startListening fires.
        setTimeout(() => { void startListening(); }, 50);
      }
    };
    window.addEventListener('vocence:open-logos', onOpen);
    return () => window.removeEventListener('vocence:open-logos', onOpen);
  }, [startListening]);

  // Auto-scroll to latest
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, state]);

  // Closing the panel discards the chat history. The backend keeps
  // conversation context only while the WS is connected (in-memory,
  // per-session), once the panel closes the WS drops, so showing stale
  // messages on next open would mislead the user into thinking the bot
  // remembers what they said before.
  const closePanel = () => {
    setOpen(false);
    cancel();
    reset();
  };
  const handleLauncherClick = () => {
    if (open) {
      closePanel();
    } else {
      setOpen(true);
    }
  };

  // ----- Drag handlers ----------------------------------------------------
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Right-click and modifier-drags are reserved for the browser
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
      moved: false,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      d.moved = true;
      setDragging(true);
    }
    if (d.moved) {
      setPos(clampToViewport({ x: d.origX + dx, y: d.origY + dy }));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = null;
    if (d.moved) {
      setDragging(false);
      // Re-anchor against the corner the user dropped near, so future
      // resizes restore the launcher to this same visual spot.
      const nextAnchor = anchorFromPos(pos);
      anchorRef.current = nextAnchor;
      try { localStorage.setItem(STORAGE_POS_KEY, JSON.stringify(nextAnchor)); } catch { /* ignore */ }
      return;
    }
    // Below threshold → it's a tap, not a drag → toggle the panel
    handleLauncherClick();
  };

  // Always-on toggle: one click starts a hands-free session (mic stays
  // hot, VAD segments turns automatically); another click ends it. Mid-
  // conversation the user never needs to touch this button.
  const handleMicClick = async () => {
    if (listening) {
      cancel();
      stopListening();
    } else {
      await startListening();
    }
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    const t = textInput;
    setTextInput('');
    await sendText(t);
  };

  // Panel position: anchored to the launcher's current location so the
  // chat opens *near* the bot wherever the user dragged it. Falls back to
  // bottom-right when window isn't ready (SSR / first render).
  const panelGeom = ((): { left: number; top: number; width: number; height: number } => {
    if (typeof window === 'undefined') {
      return { left: 0, top: 0, width: 380, height: 560 };
    }
    const PANEL_W = Math.min(380, window.innerWidth - 24);
    const PANEL_H = Math.min(560, window.innerHeight - 96);
    const GAP = 12;
    const EDGE_PAD = 12;

    const launcherCenterX = pos.x + LAUNCHER_SIZE / 2;
    const launcherCenterY = pos.y + LAUNCHER_SIZE / 2;

    // Horizontal: align panel's far edge with launcher's far edge so the
    // panel "grows from" the launcher visually.
    let left: number;
    if (launcherCenterX > window.innerWidth / 2) {
      // Launcher in right half → panel right edge = launcher right edge
      left = pos.x + LAUNCHER_SIZE - PANEL_W;
    } else {
      // Launcher in left half → panel left edge = launcher left edge
      left = pos.x;
    }

    // Vertical: open above when launcher is in lower half, below otherwise
    let top: number;
    if (launcherCenterY > window.innerHeight / 2) {
      top = pos.y - GAP - PANEL_H;
    } else {
      top = pos.y + LAUNCHER_SIZE + GAP;
    }

    // Clamp inside viewport so it never falls off-screen
    left = Math.max(EDGE_PAD, Math.min(window.innerWidth - PANEL_W - EDGE_PAD, left));
    top = Math.max(EDGE_PAD, Math.min(window.innerHeight - PANEL_H - EDGE_PAD, top));

    return { left, top, width: PANEL_W, height: PANEL_H };
  })();

  // Hide on dashboard/admin and while the Agent Architect drawer is open.
  // Both surfaces are dense and the floating launcher just gets in the way.
  const onHiddenRoute = HIDDEN_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  // Temporary launch gate: only allowlisted users see Logos.
  if (!hasAccess) return null;
  if (architectOpen || onHiddenRoute) return null;

  const stateLabel: Record<typeof state, string> = {
    idle: user ? 'Tap mic to start' : 'Sign in to chat',
    connecting: 'Connecting…',
    listening: 'Listening…',
    recording: 'Listening…',
    uploading: 'Sending…',
    transcribing: 'Transcribing…',
    thinking: 'Thinking…',
    speaking: 'Speaking',
    error: error || 'Something went wrong',
  };

  return (
    <>
      {/* Panel, anchored relative to the launcher's current position */}
      {open && (
        <div
          className="fixed z-[60] flex flex-col rounded-2xl border border-white/10 bg-[#0B0D10]/95 backdrop-blur-xl shadow-2xl shadow-black/60 overflow-hidden"
          style={{
            left: panelGeom.left,
            top: panelGeom.top,
            width: panelGeom.width,
            height: panelGeom.height,
          }}
          role="dialog"
          aria-label="Logos, the Vocence Assistant"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/[0.02]">
            <div className="flex items-center gap-2.5">
              <img
                src="/assistant/avatar.webp"
                alt=""
                className="w-9 h-9 rounded-full object-cover border border-white/15"
                aria-hidden
              />
              <div>
                <div className="text-sm font-semibold text-white leading-tight">
                  Logos <span className="text-[#A7B0B7] font-normal">· Vocence Assistant</span>
                </div>
                <div className="text-[11px] text-[#A7B0B7] leading-tight">{stateLabel[state]}</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={reset}
                className="text-xs text-[#A7B0B7] hover:text-white px-2 py-1 rounded-md hover:bg-white/5"
                title="Clear conversation"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={closePanel}
                className="p-1.5 rounded-md text-[#A7B0B7] hover:text-white hover:bg-white/5"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-sm text-[#A7B0B7] py-8">
                Hey, I'm Logos, the Vocence Assistant. Ask me about Studio features, pricing, or how to get started.
              </div>
            )}
            {messages.map((m) => {
              // System messages (session_timeout / billing_exhausted)
              // render as centered tone-coded banners so the user can
              // tell at a glance WHY the session ended.
              if (m.role === 'system') {
                const tone =
                  m.systemKind === 'billing_exhausted'
                    ? 'border-red-400/30 bg-red-500/[0.08] text-red-100'
                    : m.systemKind === 'idle_timeout' || m.systemKind === 'max_duration'
                      ? 'border-amber-300/30 bg-amber-400/[0.08] text-amber-100'
                      : 'border-white/10 bg-white/[0.04] text-[#C6CDD4]';
                return (
                  <div key={m.id} className="flex justify-center">
                    <div className={`max-w-[90%] rounded-xl border px-3.5 py-2 text-xs leading-snug text-center ${tone}`}>
                      {m.text}
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={m.id}
                  className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                      m.role === 'user'
                        ? 'bg-[#DFFF00] text-[#07080A]'
                        : 'bg-white/[0.06] text-white border border-white/10'
                    }`}
                  >
                    {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {m.tool_calls.map((tc) => <ToolCallChip key={tc.id} call={tc} />)}
                      </div>
                    )}
                    {m.pending && !m.text ? (
                      <span className="inline-flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50 animate-pulse" />
                        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50 animate-pulse [animation-delay:120ms]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50 animate-pulse [animation-delay:240ms]" />
                      </span>
                    ) : m.role === 'assistant' ? (
                      renderMessage(m.text)
                    ) : (
                      m.text
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Composer */}
          <div className="border-t border-white/10 bg-white/[0.02] p-3">
            {!user ? (
              <div className="text-center text-xs text-[#A7B0B7] py-2">
                Sign in to chat with the assistant.
              </div>
            ) : (
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={handleMicClick}
                  disabled={state === 'connecting'}
                  className={`relative shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                    listening
                      ? 'bg-red-500 text-white'
                      : 'bg-[#DFFF00] text-[#07080A] hover:brightness-110 disabled:opacity-50'
                  }`}
                  aria-label={listening ? 'End voice chat' : 'Start voice chat'}
                >
                  {listening ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
                  {listening && (
                    <span
                      className="absolute -inset-1 rounded-full border-2 border-red-400/60 pointer-events-none"
                      style={{ transform: `scale(${1 + micLevel * 0.4})` }}
                    />
                  )}
                </button>
                <form onSubmit={handleSendText} className="flex-1 flex items-end gap-2">
                  <textarea
                    rows={1}
                    value={textInput}
                    onChange={(e) => {
                      setTextInput(e.target.value);
                      // Auto-grow up to ~5 lines.
                      e.target.style.height = 'auto';
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                    }}
                    onKeyDown={(e) => {
                      // Enter submits; Shift+Enter inserts a newline.
                      // ``isComposing`` skips Enter while an IME (Chinese/
                      // Japanese/Korean) is committing a character.
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (textInput.trim()) {
                          const t = textInput;
                          setTextInput('');
                          // Reset the textarea's height after sending.
                          e.currentTarget.style.height = 'auto';
                          void sendText(t);
                        }
                      }
                    }}
                    placeholder="Type a message…"
                    title="Shift+Enter for new line"
                    disabled={state === 'connecting'}
                    className="flex-1 bg-white/[0.04] border border-white/10 rounded-2xl px-4 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 disabled:opacity-50 resize-none leading-snug"
                  />
                  <button
                    type="submit"
                    disabled={!textInput.trim() || state === 'connecting'}
                    className="shrink-0 w-9 h-9 rounded-full bg-white/[0.06] hover:bg-white/[0.10] text-white disabled:opacity-30 flex items-center justify-center"
                    aria-label="Send"
                  >
                    <Send size={16} />
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}

      {/*
        Floating launcher removed, Logos now lives in the Studio home
        spotlight card (single, prominent entry point). The panel above
        is opened programmatically via the ``vocence:open-logos`` window
        event dispatched from that card. Drag handlers and position
        persistence above are no-ops without the button, but kept in
        place so reintroducing the launcher is a one-element revert.
      */}
    </>
  );
}
