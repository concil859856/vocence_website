/**
 * ShareButton — reusable share popover for playbooks (and anything else
 * with a public URL). Renders a single Share pill that, on click, opens
 * a menu with:
 *
 *   • Native share sheet  (only when navigator.share is available — iOS,
 *                          Android, macOS Safari, Edge mobile)
 *   • Copy link           (with checkmark feedback)
 *   • X (Twitter)         (twitter.com/intent/tweet)
 *   • Reddit              (reddit.com/submit)
 *   • WhatsApp            (wa.me)
 *   • Telegram            (t.me/share)
 *   • Email               (mailto:)
 *
 * Brand logos are inlined as SVG paths from simple-icons so we don't pay
 * for an icon library and don't depend on the legacy lucide Twitter bird.
 * The intents/URL formats are the canonical share endpoints each
 * platform documents — no API tokens or app IDs required.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Share2, Link as LinkIcon, Check, Mail } from 'lucide-react';

interface Props {
  /** The public URL to share. Should be absolute (we don't normalise it
   *  here so callers stay explicit about which origin gets shared). */
  url: string;
  /** Title that appears in the tweet text, email subject, etc. */
  title: string;
  /** Optional extra text prepended to the tweet/WhatsApp/Telegram body.
   *  Falls back to ``title`` when omitted. */
  text?: string;
  /** Visual variant. ``pill`` = bordered pill with "Share" label, used
   *  in the detail header. ``compact`` = icon-only, fits inside dense
   *  community-grid cards. */
  variant?: 'pill' | 'compact';
}

export function ShareButton({ url, title, text, variant = 'pill' }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Menu position in viewport coordinates. We portal the menu to the
  // document body so it isn't clipped by ancestor `overflow-hidden`
  // (the playbook list wrapper has it for the rounded-2xl corners).
  // Position is recomputed on open + on scroll/resize so the menu
  // tracks its trigger.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const MENU_WIDTH = 224; // matches w-56 (Tailwind = 14rem at default scale)
  const MENU_MAX_HEIGHT_ESTIMATE = 320; // rough — for flip-up decision

  const computePosition = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // Default: align menu's right edge to the button's right edge,
    // sit just below the button (mt-2 = 8px).
    let left = rect.right - MENU_WIDTH;
    let top = rect.bottom + 8;
    // Flip up if there isn't room below — common in the dense table
    // rows at the bottom of the playbook list.
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < MENU_MAX_HEIGHT_ESTIMATE && rect.top > MENU_MAX_HEIGHT_ESTIMATE) {
      top = rect.top - 8 - MENU_MAX_HEIGHT_ESTIMATE;
    }
    // Clamp to viewport so menu never goes off-screen on narrow widths.
    if (left < 8) left = 8;
    if (left + MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - MENU_WIDTH - 8;
    setMenuPos({ top, left });
  };

  // Web Share API is the right default on mobile/Apple — the OS sheet
  // lists every installed app the user has, including AirDrop and
  // Messages, which always beats hardcoded buttons.
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useLayoutEffect(() => {
    if (open) computePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Recompute on scroll/resize so the menu tracks its trigger when
    // the table scrolls or the viewport changes.
    const onReposition = () => computePosition();
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
    };
  }, [open]);

  const handleNative = async () => {
    try {
      await navigator.share({ url, title, text });
      setOpen(false);
    } catch { /* user dismissed — leave menu open */ }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* */ }
  };

  const enc = encodeURIComponent;
  const shareText = (text && text.trim()) || title;
  // Intent URLs follow each platform's documented share endpoint. We
  // open them in a new tab; the user's social account session
  // (if any) handles auth — no OAuth from our side.
  const targets: Array<{ label: string; href: string; icon: JSX.Element }> = [
    {
      label: 'X',
      href: `https://twitter.com/intent/tweet?text=${enc(shareText)}&url=${enc(url)}`,
      icon: <XLogo />,
    },
    {
      label: 'Reddit',
      href: `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(title)}`,
      icon: <RedditLogo />,
    },
    {
      label: 'WhatsApp',
      // WhatsApp expects the URL inside the text body; their own client
      // detects and linkifies it. Putting it in the URL slot does
      // nothing on web.
      href: `https://wa.me/?text=${enc(`${shareText} ${url}`)}`,
      icon: <WhatsAppLogo />,
    },
    {
      label: 'Telegram',
      href: `https://t.me/share/url?url=${enc(url)}&text=${enc(shareText)}`,
      icon: <TelegramLogo />,
    },
    {
      label: 'Email',
      href: `mailto:?subject=${enc(title)}&body=${enc(`${shareText}\n\n${url}`)}`,
      icon: <Mail size={14} />,
    },
  ];

  const triggerClasses = variant === 'compact'
    ? 'flex items-center justify-center w-8 h-8 rounded-full border border-[#2e2f33] text-[#A7B0B7] hover:text-white hover:border-[#444] transition-colors'
    : 'flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#2e2f33] text-xs text-[#A7B0B7] hover:text-white hover:border-[#444] transition-colors';

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={triggerClasses}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Share"
      >
        <Share2 size={variant === 'compact' ? 14 : 12} />
        {variant === 'pill' && <span>Share</span>}
      </button>
      {open && menuPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[9999] w-56 rounded-xl border border-[#2e2f33] bg-[#111215] shadow-2xl shadow-black/60 py-1.5 overflow-hidden"
          style={{ top: menuPos.top, left: menuPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          {canNativeShare && (
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleNative()}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white hover:bg-white/[0.04] transition-colors"
            >
              <Share2 size={14} className="text-[#A7B0B7]" />
              Share via APPs…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => void handleCopy()}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white hover:bg-white/[0.04] transition-colors"
          >
            {copied
              ? <Check size={14} className="text-[#DFFF00]" />
              : <LinkIcon size={14} className="text-[#A7B0B7]" />}
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <div className="border-t border-white/[0.06] my-1" />
          {targets.map((t) => (
            <a
              key={t.label}
              href={t.href}
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white hover:bg-white/[0.04] transition-colors"
            >
              <span className="w-3.5 h-3.5 flex items-center justify-center text-[#A7B0B7]">{t.icon}</span>
              {t.label}
            </a>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Brand glyphs — simple-icons paths, rendered with currentColor so they pick
   up the menu item's text color. Kept inline (one off site of use). */

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.658l-5.214-6.817-5.967 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

function RedditLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden>
      <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.04 1.605a3.32 3.32 0 0 1 .043.52c0 2.654-3.082 4.803-6.879 4.803-3.79 0-6.873-2.143-6.873-4.803 0-.183.015-.366.043-.534A1.758 1.758 0 0 1 4.25 12.5c0-.968.786-1.754 1.754-1.754.477 0 .898.182 1.207.49 1.207-.868 2.87-1.43 4.717-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.561 8 13.25c0 .684.561 1.245 1.25 1.245.687 0 1.248-.561 1.248-1.245 0-.689-.561-1.25-1.249-1.25zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .684.561 1.245 1.249 1.245.688 0 1.249-.561 1.249-1.245 0-.689-.561-1.25-1.25-1.25zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
    </svg>
  );
}

function WhatsAppLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden>
      <path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.945C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.45L0 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.892a11.821 11.821 0 0 0-3.481-8.413A11.812 11.812 0 0 0 11.987.025c-6.554 0-11.89 5.335-11.89 11.893 0 1.99.52 3.93 1.51 5.642L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.71.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z" />
    </svg>
  );
}

function TelegramLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}
