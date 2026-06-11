import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap, Brain, Phone, PhoneOff, Wrench, Wand2, Play, Send } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useVoiceChat } from '../lib/voicechat/useVoiceChat';
import { blockIfVoiceAgentsComingSoon } from '../lib/voiceAgentsComingSoon';
import { API_ORIGIN_BASE } from '../services/baseUrl';

/**
 * Voice Agents spotlight card for the Studio home page.
 *
 * Two-column card: copy + CTAs on the left, an interactive "live
 * call" panel on the right.
 *
 * The right panel has two modes:
 *   • idle , cycles a scripted transcript + animated waveform so the
 *             card is alive when nobody's actively calling.
 *   • live , real voice session against Logos. The phone icon in the
 *             panel header toggles between modes; once live, real
 *             messages stream in and the demo waveform disappears
 *             (replaced by a small mic-level indicator).
 *
 * The left "Design agent" CTA navigates to /studio/agents, Logos is
 * the call demo, the agents page is where users actually build their
 * own agents.
 */

const SCRIPT: Array<{ role: 'agent' | 'caller'; text: string }> = [
  { role: 'agent',  text: 'Hi, this is Logos from Vocence, how can I help today?' },
  { role: 'caller', text: 'I was charged twice this month.' },
  { role: 'agent',  text: 'I see the duplicate charge and I’ve issued a refund, 3–5 business days.' },
  { role: 'caller', text: 'Amazing, thank you!' },
  { role: 'agent',  text: 'Anytime. Have a great day!' },
];

const TURN_DELAY_MS = 1500;
const POST_SCRIPT_PAUSE_MS = 3200;


/** Call state shared between the header (toggle + status pill) and
 *  the body (transcript) + foot (mic indicator). useState would
 *  require prop-drilling through three siblings; this keeps it tidy. */
/** System messages we treat as the session being OVER. Anything else
 *  with role='system' (e.g. an 'info' banner) leaves the call alive. */
const TERMINAL_SYSTEM_KINDS = new Set<string>([
  'idle_timeout',
  'max_duration',
  'billing_exhausted',
]);

interface CallCtx {
  live: boolean;
  /** True while the WS is alive and the server hasn't sent a TERMINAL
   *  system notice. Goes false the instant the backend auto-ends so
   *  the toggle button and status pill stop showing the call as
   *  active. Non-terminal system messages ('info', etc.) keep the
   *  call active. */
  callActive: boolean;
  toggle: () => void;
  liveMessages: Array<{
    id: string;
    role: 'agent' | 'caller' | 'system';
    text: string;
    systemKind?: string;
  }>;
  micLevel: number;
  statusLabel: string;
  signedIn: boolean;
  sendText: (text: string) => Promise<void> | void;
  state: string;
  errorMessage: string | null;
}

// (Logos's opening greeting is now spoken by the server, the
// voicechat WS sends it as a synthetic ``token`` + TTS audio on
// connect. We used to paint a static text bubble here as a stand-in,
// but it would now duplicate the real bubble that arrives moments
// later from the server.)
const CallContext = createContext<CallCtx | null>(null);
const useCall = () => {
  const v = useContext(CallContext);
  if (!v) throw new Error('useCall outside CallContext');
  return v;
};


export function StudioVoiceAgentSpotlight() {
  const { user } = useAuth();
  const [live, setLive] = useState(false);
  // Token resolution for the voicechat WS:
  //   1. Legacy ``vocence_token`` (still works during the cookie-auth
  //      migration; will be empty for users who logged in via email).
  //   2. ``'cookie-session'`` sentinel when ``vocence_user`` indicates
  //      the user IS logged in but only the HttpOnly session cookie
  //      carries the actual JWT — the WS upgrade picks up the cookie
  //      same-origin and the backend's auth path tries cookie before
  //      query-param token. Same pattern as lib/agents/api.getStoredToken
  //      and StudioPlaybooks. Without this, ``!!token`` was always
  //      false for cookie-only sessions and ``enabled`` stayed false,
  //      so the WS never opened — Logos showed "not connected" forever.
  const readToken = (): string | null => {
    if (typeof window === 'undefined') return null;
    const legacy = localStorage.getItem('vocence_token');
    if (legacy) return legacy;
    if (localStorage.getItem('vocence_user')) return 'cookie-session';
    return null;
  };
  const [token, setToken] = useState<string | null>(readToken);

  // Re-read the token across login/logout (AuthContext doesn't expose it).
  useEffect(() => {
    setToken(readToken());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Embedded voice session. ``enabled`` is gated on ``live`` so the WS
  // only opens once the user actually clicks the phone, no eager
  // connection on page load.
  const {
    state, messages, micLevel, error, startListening, stopListening, cancel, reset, sendText,
  } = useVoiceChat({
    enabled: live && !!token && !!user,
    authToken: token,
    alwaysOn: true,
  });

  // Auto-start the mic the moment the WS finishes connecting. The
  // useVoiceChat hook's initial state is also 'idle' (before connect
  // begins), so just watching for 'idle' would fire too early and
  // throw "not connected". Instead we wait for the connecting → idle
  // transition: 'connecting' means the WS is mid-open, 'idle' after
  // that means the open completed.
  const sawConnectingRef = useRef(false);
  useEffect(() => {
    if (!live) {
      sawConnectingRef.current = false;
      return;
    }
    if (state === 'connecting') {
      sawConnectingRef.current = true;
      return;
    }
    if (sawConnectingRef.current && state === 'idle') {
      sawConnectingRef.current = false;   // one-shot per call
      void startListening();
    }
  }, [live, state, startListening]);

  // Derive "is the call actually active right now?". A trailing
  // TERMINAL system message means the backend ended the session
  // (idle / max-duration / billing exhausted). Non-terminal system
  // messages (e.g. 'info') leave the call alive.
  const lastMessageForToggle = messages[messages.length - 1];
  const sessionEndedByServer =
    !!lastMessageForToggle &&
    lastMessageForToggle.role === 'system' &&
    TERMINAL_SYSTEM_KINDS.has(lastMessageForToggle.systemKind ?? '');
  const callActive = live && !sessionEndedByServer;

  const toggle = () => {
    // Active call → end it. Inactive (either never started, or server
    // already auto-ended) → start a new one.
    if (callActive) {
      cancel();
      stopListening();
      reset();
      setLive(false);
    } else {
      // Coming-soon gate. Blocks the actual Logos call but the rest
      // of the panel UI (scripted idle transcript + waveform) keeps
      // playing so the card still feels alive.
      if (blockIfVoiceAgentsComingSoon()) return;
      if (!user) {
        // Not signed in, UI tooltips will explain.
        return;
      }
      if (live) {
        // We're in the post-auto-end window. Clean out the old session
        // before flipping back to live so the new call starts fresh.
        cancel();
        stopListening();
        reset();
        setLive(false);
        // Defer the live=true flip one tick so the connect effect
        // sees enabled=false → enabled=true rather than a no-op.
        window.setTimeout(() => setLive(true), 0);
      } else {
        setLive(true);
      }
    }
  };

  const liveMessages = useMemo(
    () => messages.map((m) => ({
      id: m.id,
      role: (
        m.role === 'user'   ? 'caller' :
        m.role === 'system' ? 'system' :
        'agent'
      ) as 'caller' | 'agent' | 'system',
      text: m.text,
      systemKind: m.systemKind,
    })),
    [messages]
  );

  // Backend auto-end (idle 60s, max 30min, balance exhausted) emits a
  // system message with a TERMINAL ``systemKind`` right before closing
  // the WS. ONLY tear down on those kinds, a plain 'info' system
  // banner from the backend would otherwise eject the user mid-call.
  useEffect(() => {
    if (!live) return;
    const last = messages[messages.length - 1];
    if (last?.role !== 'system') return;
    if (!TERMINAL_SYSTEM_KINDS.has(last.systemKind ?? '')) return;
    // Stop everything client-side right away, mic off, WS torn down.
    cancel();
    stopListening();
    // Defer the demo-reset so the system bubble lingers a beat.
    const t = window.setTimeout(() => setLive(false), 3000);
    return () => window.clearTimeout(t);
  }, [messages, live, cancel, stopListening]);

  const statusLabel = !live
    ? 'live'
    : state === 'connecting' ? 'connecting'
    : state === 'listening' || state === 'recording' ? 'listening'
    : state === 'transcribing' ? 'transcribing'
    : state === 'thinking' ? 'thinking'
    : state === 'speaking' ? 'speaking'
    : state === 'error' ? 'error'
    : 'live';

  const ctx: CallCtx = {
    live,
    callActive,
    toggle,
    liveMessages,
    micLevel,
    statusLabel,
    signedIn: !!user,
    sendText,
    state,
    errorMessage: error,
  };

  return (
    <CallContext.Provider value={ctx}>
      <section
        className="
          relative overflow-hidden rounded-[28px]
          border border-white/[0.08] bg-[#08080D]
          grid grid-cols-1 lg:grid-cols-2
        "
      >
        {/* Soft top-right wash so the right panel doesn't feel like a
            separate card. Subtle, sticks to brand chartreuse. */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(900px 500px at 88% 10%, rgba(223,255,0,0.06), transparent 60%)',
          }}
        />

        <CopyPane />
        <CallPane />
      </section>
    </CallContext.Provider>
  );
}


/* ------------------------------------------------------------------ */
/*  LEFT: ribbon + headline + features + CTAs + stats                  */
/* ------------------------------------------------------------------ */

function CopyPane() {
  return (
    <div className="relative px-7 py-10 md:px-12 md:py-14 flex flex-col justify-center">
      <span
        className="
          inline-flex items-center gap-2 self-start
          rounded-full px-3.5 py-1.5
          text-[11.5px] font-bold uppercase tracking-[0.08em]
          text-[#08080d]
          bg-gradient-to-r from-[#DFFF00] via-[#9EFF66] to-[#5BE8C5]
        "
      >
        <Zap className="h-3.5 w-3.5" fill="currentColor" />
        Flagship · Voice Agents
      </span>

      <h2 className="mt-5 font-bold leading-[1.05] tracking-tight text-white text-[32px] md:text-[42px]">
        Conversations that<br />
        <span className="text-[#DFFF00]">think on their feet.</span>
      </h2>

      <p className="mt-4 max-w-[460px] text-[15px] leading-relaxed text-white/65">
        Production-ready voice agents that listen, reason, and respond
        in real time, your voices, your knowledge, your tools. Deploy
        to phone, web, or app.
      </p>

      <ul className="mt-6 mb-7 flex flex-col gap-3.5">
        <Feature
          icon={<Brain className="h-[17px] w-[17px]" />}
          title="Reasoning built in"
          sub="Connect knowledge and let agents resolve, not just read."
        />
        <Feature
          icon={<Phone className="h-[17px] w-[17px]" />}
          title="Sub-second, full-duplex"
          sub="Natural turn-taking with barge-in and interruption handling."
        />
        <Feature
          icon={<Wrench className="h-[17px] w-[17px]" />}
          title="Tools & actions"
          sub="Book, transfer, look up orders, send links, mid-conversation."
        />
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/studio/agents/new"
          className="
            group inline-flex items-center gap-2
            rounded-full px-5 py-3 text-sm font-semibold
            bg-white text-[#08080D]
            shadow-[0_10px_28px_-12px_rgba(255,255,255,0.45)]
            transition-transform hover:-translate-y-0.5
          "
        >
          <Wand2 className="h-4 w-4" />
          Build an agent
        </Link>
        <button
          type="button"
          className="
            inline-flex items-center gap-2
            rounded-full border border-white/[0.12] bg-white/[0.03]
            px-5 py-3 text-sm font-medium text-white/85
            hover:bg-white/[0.07] transition-colors
          "
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-white/10">
            <Play className="h-3 w-3 fill-white text-white" />
          </span>
          Watch demo
        </button>
      </div>

      <VoiceStatsRow />
    </div>
  );
}


function Feature({
  icon, title, sub,
}: {
  icon: React.ReactNode; title: string; sub: string;
}) {
  return (
    <li className="flex gap-3 items-start">
      <span
        className="
          grid h-[34px] w-[34px] place-items-center rounded-[10px] shrink-0
          bg-[#DFFF00]/[0.10] text-[#DFFF00]
        "
      >
        {icon}
      </span>
      <div>
        <div className="text-[14.5px] font-semibold text-white leading-tight">{title}</div>
        <div className="mt-1 text-[13px] leading-snug text-white/60">{sub}</div>
      </div>
    </li>
  );
}


function Stat({
  value, label, accent = false,
}: {
  value: string; label: string; accent?: boolean;
}) {
  return (
    <div>
      <dt
        className={
          'text-[26px] md:text-[30px] font-semibold tracking-tight ' +
          (accent ? 'text-[#DFFF00]' : 'text-white')
        }
      >
        {value}
      </dt>
      <dd className="mt-0.5 text-[10.5px] tracking-[0.08em] uppercase text-white/40 font-mono">
        {label}
      </dd>
    </div>
  );
}


/** Pulls real numbers from /api/dashboard/public/stats/voice. Renders
 *  a thin skeleton while in flight; if the fetch fails we fall back
 *  to the known languages count and skip the live counters rather
 *  than show misleading zeros. */
function VoiceStatsRow() {
  const [stats, setStats] = useState<{
    calls: number | null;
    languages: number;
    agents: number | null;
  }>({ calls: null, languages: 24, agents: null });
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_ORIGIN_BASE}/api/dashboard/public/stats/voice`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setStats({
          calls: typeof data?.calls_handled === 'number' ? data.calls_handled : null,
          languages: typeof data?.languages === 'number' ? data.languages : 24,
          agents: typeof data?.agents_created === 'number' ? data.agents_created : null,
        });
      })
      .catch(() => { /* leave defaults; live tiles stay hidden */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <dl className="mt-9 flex flex-wrap gap-x-9 gap-y-3">
      {stats.calls !== null && (
        <Stat value={formatCount(stats.calls)} label="Calls handled" accent />
      )}
      {stats.agents !== null && (
        <Stat value={formatCount(stats.agents)} label="Agents created" />
      )}
      <Stat value={String(stats.languages)} label="Languages" />
    </dl>
  );
}


/** 1234 → "1,234"; 12_345 → "12.3K"; 1_234_567 → "1.23M". Keeps the
 *  tile compact regardless of scale. */
function formatCount(n: number): string {
  if (n < 1_000)     return n.toLocaleString();
  if (n < 1_000_000) return (n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}


/* ------------------------------------------------------------------ */
/*  RIGHT: live call panel (video avatar + scripted transcript)        */
/* ------------------------------------------------------------------ */

function CallPane() {
  const { live } = useCall();
  return (
    <div className="relative p-6 md:p-10 grid place-items-center">
      <div
        className="
          w-full max-w-[380px] rounded-3xl overflow-hidden
          border border-white/[0.08] bg-[#0D0D16]/60
          shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]
        "
      >
        <CallHeader />
        <CallBody />
        <CallFoot />
        {/* Text input only meaningful during an actual call, the
            demo loop has nothing to send to. */}
        {live && <CallTextInput />}
      </div>
    </div>
  );
}


/** Type-to-send row matching the old VocenceBot panel's UX: enter to
 *  send, shift+enter for newline, disabled while a turn is still
 *  resolving so the user doesn't double-fire. */
function CallTextInput() {
  const { sendText } = useCall();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = async () => {
    const t = value.trim();
    if (!t || sending) return;
    setSending(true);
    setValue('');
    if (taRef.current) taRef.current.style.height = 'auto';
    try {
      await sendText(t);
    } finally {
      setSending(false);
      // Keep focus on the textarea so the user can immediately type
      // a follow-up, Enter blur on submit otherwise forces a click
      // back into the input between every message.
      taRef.current?.focus();
    }
  };

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      className="
        flex items-end gap-2 px-3 py-3
        border-t border-white/[0.08]
        bg-white/[0.02]
      "
    >
      <textarea
        ref={taRef}
        rows={1}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          // Auto-grow up to ~4 lines so the panel doesn't lurch.
          e.target.style.height = 'auto';
          e.target.style.height = `${Math.min(e.target.scrollHeight, 96)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Type a message…"
        // Intentionally NOT disabled while sending, disabling blurs
        // the textarea, and React's re-enable on the next render races
        // with our refocus(), leaving the cursor outside the field.
        // The send button itself is gated, which is enough.
        className="
          flex-1 bg-white/[0.04] border border-white/[0.10] rounded-2xl
          px-3.5 py-2 text-[13px] text-white placeholder:text-white/35
          focus:outline-none focus:border-[#DFFF00]/40
          resize-none leading-snug
        "
      />
      <button
        type="submit"
        disabled={!value.trim() || sending}
        aria-label="Send"
        className="
          shrink-0 w-9 h-9 rounded-full flex items-center justify-center
          bg-[#DFFF00] text-[#08080D] disabled:opacity-30 disabled:cursor-not-allowed
          hover:bg-[#DFFF00]/90 transition-colors
        "
      >
        <Send className="h-[15px] w-[15px]" />
      </button>
    </form>
  );
}


function CallHeader() {
  const { callActive, toggle, signedIn } = useCall();
  return (
    <div
      className="
        flex items-center gap-3 px-4 py-3.5
        border-b border-white/[0.08]
        bg-white/[0.02]
      "
    >
      <Avatar />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-white">Logos, Vocence Assistant</div>
        <div className="mt-0.5">
          <LivePill />
        </div>
      </div>
      <button
        type="button"
        onClick={toggle}
        title={
          !signedIn
            ? 'Sign in to start a call'
            : callActive ? 'End call' : 'Start call'
        }
        disabled={!signedIn}
        className={
          'inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors ' +
          (callActive
            ? 'bg-red-500/90 text-white hover:bg-red-500'
            : 'bg-[#DFFF00] text-[#08080D] hover:bg-[#DFFF00]/90') +
          (!signedIn ? ' opacity-40 cursor-not-allowed' : '')
        }
        aria-label={callActive ? 'End call' : 'Start call'}
      >
        {callActive
          ? <PhoneOff className="h-[15px] w-[15px]" />
          : <Phone    className="h-[15px] w-[15px]" />}
      </button>
    </div>
  );
}


function Avatar() {
  // The video is the same one the floating launcher used to play —
  // gives Logos a recognisable face here too. Webp poster appears on
  // browsers / preferences that suppress autoplay.
  return (
    <div
      className="h-10 w-10 rounded-[11px] overflow-hidden shrink-0"
      style={{ background: 'linear-gradient(135deg, #6E8BFF, #29E0D6)' }}
    >
      <video
        src="/avatar.mp4"
        poster="/assistant/avatar.webp"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        className="h-full w-full object-cover"
        aria-hidden
      />
    </div>
  );
}


function LivePill() {
  const { live, callActive, statusLabel } = useCall();
  // Three states: not live (demo), call active (red), call ended (gray).
  const ended = live && !callActive;
  const colorRgb = ended
    ? 'rgb(160,160,170)'
    : callActive ? 'rgb(248,113,113)' : 'rgb(52,211,153)';
  const textCls = ended
    ? 'text-white/45'
    : callActive ? 'text-red-400' : 'text-emerald-400';
  const label = ended ? 'ended' : statusLabel;
  return (
    <span className={'inline-flex items-center gap-1.5 text-[11px] font-mono ' + textCls}>
      <i
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: colorRgb,
          boxShadow: `0 0 8px ${colorRgb}`,
          // No pulse animation in 'ended' state, the dot freezes.
          animation: ended ? 'none' : 'voc-spot-blink 1.6s ease-in-out infinite',
        }}
      />
      {label}
    </span>
  );
}


/** Body renders one of two streams:
 *    • idle , scripted, looping demo transcript
 *    • live , real messages from the active useVoiceChat session
 *  Switch happens instantly when the phone toggle flips ``live``. */
function CallBody() {
  const { live, liveMessages, state, errorMessage } = useCall();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ---- demo loop driver -------------------------------------------------
  const [visibleIndex, setVisibleIndex] = useState(0);
  useEffect(() => {
    if (live) return;       // demo pauses while a real call is in flight
    let cancelled = false;
    let timer: number | undefined;
    const tick = (i: number) => {
      if (cancelled) return;
      if (i >= SCRIPT.length) {
        timer = window.setTimeout(() => {
          if (cancelled) return;
          setVisibleIndex(0);
          timer = window.setTimeout(() => tick(1), 400);
        }, POST_SCRIPT_PAUSE_MS);
        return;
      }
      setVisibleIndex(i);
      timer = window.setTimeout(() => tick(i + 1), TURN_DELAY_MS);
    };
    timer = window.setTimeout(() => tick(1), 500);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [live]);

  // Auto-scroll to the latest bubble regardless of mode. The deps
  // include the LAST bubble's text length so the panel keeps following
  // the assistant's reply as the paced text reveal grows it character-
  // by-character, without this, the scrollbar froze on the first
  // visible line and the user had to drag the panel down to read
  // Logos's full answer.
  const lastLiveText = liveMessages[liveMessages.length - 1]?.text ?? '';
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleIndex, liveMessages.length, lastLiveText]);

  return (
    <div
      ref={scrollRef}
      className="
        p-4 flex flex-col gap-3 min-h-[260px] max-h-[260px] overflow-y-auto
        bg-[#08080D]/60
      "
    >
      {live ? (
        <>
          {state === 'error' ? (
            <div
              className="
                self-stretch mx-2 mt-2 px-3 py-2 rounded-xl
                bg-red-500/10 border border-red-500/30
                text-[12px] text-red-300 font-mono break-words
              "
            >
              {errorMessage || 'Connection failed. Tap the red phone to retry.'}
            </div>
          ) : liveMessages.length === 0 ? (
            <div className="self-center text-[11px] text-white/40 font-mono mt-1">
              {state === 'connecting' ? 'connecting…' : 'ready · say hi'}
            </div>
          ) : (
            liveMessages.map((m) => (
              <Bubble key={m.id} role={m.role}>{m.text}</Bubble>
            ))
          )}
        </>
      ) : (
        SCRIPT.slice(0, visibleIndex).map((line, i) => (
          <Bubble key={`demo-${i}`} role={line.role}>{line.text}</Bubble>
        ))
      )}
    </div>
  );
}

function Bubble({
  role, children,
}: {
  role: 'agent' | 'caller' | 'system'; children: React.ReactNode;
}) {
  if (role === 'system') {
    // Backend session-end notices (idle timeout, max duration, billing
    // exhausted, etc.). Centered + dimmed so it reads as meta, not as
    // either party speaking.
    return (
      <div
        className="
          self-center max-w-[90%] px-3 py-1.5 rounded-full
          bg-white/[0.04] border border-white/[0.08]
          text-[11px] text-white/55 font-mono text-center
          voc-spot-bubble-in
        "
      >
        {children}
      </div>
    );
  }
  return (
    <div
      className={
        'max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-snug ' +
        'voc-spot-bubble-in ' +
        (role === 'agent'
          ? 'self-start bg-[#1C1C28] border border-white/[0.08] text-white rounded-bl-md'
          : 'self-end bg-[#7C6BFF] text-white rounded-br-md')
      }
    >
      {children}
    </div>
  );
}


function CallFoot() {
  const { live } = useCall();
  return (
    <div
      className="
        flex items-center gap-4 px-4 py-3.5
        border-t border-white/[0.08]
        bg-white/[0.02]
      "
    >
      {live ? <LiveMicLevel /> : <Waveform />}
      <Timer resetKey={live ? 'live' : 'idle'} />
    </div>
  );
}

/** A thin pulsing bar that scales with the real mic level, replaces
 *  the decorative waveform once a call is live. */
function LiveMicLevel() {
  const { micLevel } = useCall();
  const pct = Math.max(6, Math.min(100, micLevel * 140));
  return (
    <div className="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
      <div
        className="h-full rounded-full transition-[width] duration-100"
        style={{
          width: `${pct}%`,
          background:
            'linear-gradient(90deg, #DFFF00 0%, #9EFF66 60%, #5BE8C5 100%)',
          boxShadow: '0 0 12px rgba(223,255,0,0.55)',
        }}
      />
    </div>
  );
}


/** Deterministic procedurally-generated waveform (matches Studio's
 *  on-page bars, quick visual cue that audio is moving). Pure CSS
 *  animation per bar so it never re-renders. */
function Waveform() {
  const bars = useMemo(() => {
    const n = 34;
    const out: number[] = [];
    let h = 0x9E370B; // fixed seed
    for (let i = 0; i < n; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      const env = Math.sin((i / n) * Math.PI);
      const r = ((h >>> 8) % 1000) / 1000;
      out.push(Math.max(12, 14 + (0.3 + 0.7 * r) * env * 86));
    }
    return out;
  }, []);
  return (
    <div className="flex-1 flex items-center gap-[2px] h-10">
      {bars.map((v, i) => (
        <i
          key={i}
          className="flex-1 rounded-[2px] bg-white/30 voc-spot-bar"
          style={{
            height: `${v}%`,
            animationDelay: `${(i % 7) * 0.12}s`,
          }}
        />
      ))}
    </div>
  );
}


function Timer({ resetKey }: { resetKey?: string }) {
  const [s, setS] = useState(0);
  // Restart the clock whenever the parent flips modes (idle <-> live).
  useEffect(() => { setS(0); }, [resetKey]);
  useEffect(() => {
    const id = window.setInterval(() => setS((x) => (x + 1) % 6000), 1000);
    return () => window.clearInterval(id);
  }, []);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (
    <span className="text-[11px] font-mono text-white/35">{mm}:{ss}</span>
  );
}


/* ------------------------------------------------------------------ */
/*  Co-located keyframes                                               */
/* ------------------------------------------------------------------ */

if (typeof document !== 'undefined' && !document.getElementById('voc-spot-styles')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'voc-spot-styles';
  styleEl.textContent = `
    @keyframes voc-spot-bubble-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: none;            }
    }
    .voc-spot-bubble-in { animation: voc-spot-bubble-in 0.4s ease-out both; }

    @keyframes voc-spot-blink {
      0%, 100% { opacity: 1;    }
      50%      { opacity: 0.35; }
    }

    @keyframes voc-spot-bar {
      0%, 100% { transform: scaleY(0.65); opacity: 0.45; }
      50%      { transform: scaleY(1.00); opacity: 0.95; }
    }
    .voc-spot-bar {
      transform-origin: center;
      animation: voc-spot-bar 1.4s ease-in-out infinite;
      background: linear-gradient(180deg, #FF5DA2, #C26BFF 32%, #6E8BFF 64%, #29E0D6);
    }

    @media (prefers-reduced-motion: reduce) {
      .voc-spot-bubble-in, .voc-spot-bar { animation: none !important; }
    }
  `;
  document.head.appendChild(styleEl);
}
