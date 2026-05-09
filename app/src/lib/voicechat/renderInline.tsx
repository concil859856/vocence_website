/**
 * Markdown renderer for the Vocence Assistant + agent chat bubbles.
 *
 * Two layers:
 *   • ``renderInline`` handles bold, italic, strike, inline code, and
 *     explicit ``[text](url)`` links — used inside any line of text.
 *   • ``renderMessage`` is the line-aware wrapper used by chat bubbles
 *     — it recognises block-level markdown (``### headings``, ``-``
 *     bullets, numbered lists) and renders them as proper UI elements,
 *     so a reply like ``### Key Milestones:\n- 1999: Launch`` looks
 *     like a real heading + bullet, not raw text.
 *
 * The backend prompt forbids the LLM from emitting ANY of this — we
 * keep the renderer defensive (belt-and-suspenders) so the visual
 * never shows raw ``###`` markers if the model slips.
 *
 * Streaming-safe: incomplete markup like ``"**Voce"`` matches no
 * pattern and is rendered as plain text until the closing pair arrives.
 */

import type { ReactNode } from 'react';

interface Match {
  start: number;
  end: number;
  node: ReactNode;
}

const PATTERNS: Array<{
  re: RegExp;
  build: (m: RegExpExecArray, key: string) => ReactNode;
}> = [
  // Inline code first — its content shouldn't be re-parsed.
  {
    re: /`([^`\n]+)`/g,
    build: (m, key) => (
      <code key={key} className="px-1 py-[1px] rounded bg-white/10 text-[0.92em] font-mono">
        {m[1]}
      </code>
    ),
  },
  // Bold (**text** or __text__)
  {
    re: /\*\*([^*\n]+)\*\*/g,
    build: (m, key) => <strong key={key}>{m[1]}</strong>,
  },
  {
    re: /__([^_\n]+)__/g,
    build: (m, key) => <strong key={key}>{m[1]}</strong>,
  },
  // Strikethrough
  {
    re: /~~([^~\n]+)~~/g,
    build: (m, key) => <s key={key}>{m[1]}</s>,
  },
  // Markdown link [text](http://...)
  {
    re: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    build: (m, key) => (
      <a
        key={key}
        href={m[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:text-[#DFFF00]"
      >
        {m[1]}
      </a>
    ),
  },
  // Italic (*text*) — must come AFTER bold to avoid eating its asterisks.
  {
    re: /\*([^*\n]+)\*/g,
    build: (m, key) => <em key={key}>{m[1]}</em>,
  },
  // Italic (_text_) — guard against in-word underscores like snake_case.
  {
    re: /(?<!\w)_([^_\n]+)_(?!\w)/g,
    build: (m, key) => <em key={key}>{m[1]}</em>,
  },
];

function findEarliest(text: string, fromIdx: number): Match | null {
  let best: Match | null = null;
  for (const { re, build } of PATTERNS) {
    re.lastIndex = fromIdx;
    const m = re.exec(text);
    if (!m) continue;
    if (best === null || m.index < best.start) {
      best = {
        start: m.index,
        end: m.index + m[0].length,
        node: build(m, `m-${m.index}`),
      };
    }
  }
  return best;
}

export function renderInline(text: string): ReactNode[] {
  if (!text) return [];
  const out: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const match = findEarliest(text, i);
    if (!match) {
      out.push(text.slice(i));
      break;
    }
    if (match.start > i) out.push(text.slice(i, match.start));
    out.push(match.node);
    i = match.end;
  }
  return out;
}


// ---------------------------------------------------------------------------
// Block-level renderer — used by chat bubbles. Splits on newlines, classifies
// each line as a heading / bullet / numbered / blank / paragraph, and runs
// inline rendering inside each.
//
// Why bother when the prompt forbids markdown? Because LLMs (especially small
// ones like Qwen3-4B) sometimes slip. Without this layer, a reply like
// ``### Key Milestones:\n- 1999: Launch`` shows the literal hashes and
// dashes in the bubble. With it, the bubble shows a real heading and
// bullet, so the UX never looks broken.
// ---------------------------------------------------------------------------

const HEADING_RE = /^\s*(#{1,6})\s+(.+)$/;
const BULLET_RE = /^\s*[-*+]\s+(.+)$/;
const NUMBERED_RE = /^\s*(\d{1,3})[.)]\s+(.+)$/;
const HRULE_RE = /^\s*-{3,}\s*$/;

export function renderMessage(text: string): ReactNode {
  if (!text) return null;
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line → small vertical gap
    if (trimmed === '') {
      blocks.push(<div key={i} className="h-1.5" aria-hidden />);
      continue;
    }

    // Horizontal rule
    if (HRULE_RE.test(line)) {
      blocks.push(<hr key={i} className="my-2 border-white/10" />);
      continue;
    }

    // Heading (### Foo)
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const sizeCls = level <= 2 ? 'text-[15px]' : 'text-[14px]';
      blocks.push(
        <div key={i} className={`${sizeCls} font-semibold text-white mt-1.5 mb-0.5`}>
          {renderInline(h[2])}
        </div>,
      );
      continue;
    }

    // Bullet (- Foo, * Foo, + Foo)
    const b = BULLET_RE.exec(line);
    if (b) {
      blocks.push(
        <div key={i} className="flex gap-2 leading-snug">
          <span className="text-[#A7B0B7] select-none">•</span>
          <span className="flex-1">{renderInline(b[1])}</span>
        </div>,
      );
      continue;
    }

    // Numbered (1. Foo, 1) Foo)
    const n = NUMBERED_RE.exec(line);
    if (n) {
      blocks.push(
        <div key={i} className="flex gap-2 leading-snug">
          <span className="text-[#A7B0B7] tabular-nums select-none shrink-0">{n[1]}.</span>
          <span className="flex-1">{renderInline(n[2])}</span>
        </div>,
      );
      continue;
    }

    // Plain paragraph
    blocks.push(
      <div key={i} className="leading-snug">
        {renderInline(line)}
      </div>,
    );
  }
  return <>{blocks}</>;
}
