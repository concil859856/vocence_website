/**
 * Markdown renderer for the Vocence Assistant + agent chat bubbles.
 *
 * Two layers:
 *   • ``renderInline`` handles bold, italic, strike, inline code, and
 *     explicit ``[text](url)`` links, used inside any line of text.
 *   • ``renderMessage`` is the line-aware wrapper used by chat bubbles
 *    , it recognises block-level markdown (``### headings``, ``-``
 *     bullets, numbered lists) and renders them as proper UI elements,
 *     so a reply like ``### Key Milestones:\n- 1999: Launch`` looks
 *     like a real heading + bullet, not raw text.
 *
 * The backend prompt forbids the LLM from emitting ANY of this, we
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
  // Inline code first, its content shouldn't be re-parsed.
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
  // Italic (*text*), must come AFTER bold to avoid eating its asterisks.
  {
    re: /\*([^*\n]+)\*/g,
    build: (m, key) => <em key={key}>{m[1]}</em>,
  },
  // Italic (_text_), guard against in-word underscores like snake_case.
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
// Worded-number → digit conversion
//
// LLMs tend to spell numbers out as English words because that's what TTS
// reads naturally ("six billion nine hundred forty million" sounds right
// when spoken). But in the chat BUBBLE the user wants to SCAN, a digit
// like "6,940,393,680" is far easier to read at a glance.
//
// We only convert runs that include a magnitude word (hundred / thousand /
// million / billion / trillion), so "two cats" stays as prose but
// "two billion dollars" becomes "2,000,000,000 dollars". TTS still
// receives the original LLM text (this only runs on the display path),
// so the agent still SPEAKS the words naturally.
// ---------------------------------------------------------------------------

const NUM_SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUM_SCALE: Record<string, number> = {
  hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000, trillion: 1_000_000_000_000,
};
// Word tokens that can appear inside a number phrase as connectors
// without ending it. "one hundred and twenty" → 120.
const NUM_FILLER = new Set(['and', 'a']);

/** Try to parse a sequence of tokens as a single English number.
 *  Returns null if any token is not a number word / connector. */
function parseNumberRun(tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  let total = 0;
  let current = 0;
  let consumed = false;
  for (const raw of tokens) {
    const t = raw.toLowerCase();
    if (NUM_FILLER.has(t)) continue;
    if (NUM_SMALL[t] !== undefined) {
      current += NUM_SMALL[t];
      consumed = true;
    } else if (t === 'hundred') {
      current = (current || 1) * 100;
      consumed = true;
    } else if (NUM_SCALE[t] !== undefined) {
      total += (current || 1) * NUM_SCALE[t];
      current = 0;
      consumed = true;
    } else {
      return null;
    }
  }
  if (!consumed) return null;
  return total + current;
}

/** Replace runs of worded numbers with comma-formatted digits.
 *  Only runs that include hundred/thousand/million/billion/trillion are
 *  converted, so casual prose like "two cats" survives intact. */
export function wordedNumbersToDigits(text: string): string {
  if (!text) return text;
  // Split into tokens with their separators so we can reassemble.
  // A "word" is letters; hyphens like "ninety-three" are inner separators
  // we treat as token boundaries too so "ninety" and "three" parse
  // separately. Punctuation other than hyphens splits runs.
  const NUM_WORD = /[a-zA-Z]+/g;
  type Tok = { start: number; end: number; word: string };
  const toks: Tok[] = [];
  let m: RegExpExecArray | null;
  while ((m = NUM_WORD.exec(text)) !== null) {
    toks.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  }

  const isNumWord = (w: string) => {
    const t = w.toLowerCase();
    return NUM_SMALL[t] !== undefined || NUM_SCALE[t] !== undefined || NUM_FILLER.has(t);
  };

  const ranges: { start: number; end: number; value: number }[] = [];
  // Only whitespace and hyphens may separate two tokens that belong
  // to the same number run. Anything else (comma, period, semicolon,
  // letter from a different language, etc.) breaks the run so that
  // e.g. "twelve, thousand" stays as written rather than collapsing
  // into "12,000".
  const GAP_OK = /^[\s-]*$/;
  let i = 0;
  while (i < toks.length) {
    if (!isNumWord(toks[i].word)) { i++; continue; }
    let j = i;
    let hasMagnitude = false;
    while (j < toks.length && isNumWord(toks[j].word)) {
      if (j > i) {
        const gap = text.slice(toks[j - 1].end, toks[j].start);
        if (!GAP_OK.test(gap)) break;
      }
      const t = toks[j].word.toLowerCase();
      if (NUM_SCALE[t] !== undefined) hasMagnitude = true;
      j++;
    }
    // Don't trim FILLER on the boundaries, they'd flip non-number runs
    // ("a cat") into number runs. So if the run is just fillers, skip.
    const runTokens = toks.slice(i, j).filter((t) => !NUM_FILLER.has(t.word.toLowerCase()));
    // Require a leading quantity word (small number or "hundred") so
    // bare "thousand" / "million" / "billion" don't silently expand
    // to 1,000 / 1,000,000 / etc. ("about 12 thousand" should keep
    // "thousand" as a word since the preceding "12" is a digit and
    // not in our token list.)
    const hasLeadingQuantity = runTokens.length > 0
      && (NUM_SMALL[runTokens[0].word.toLowerCase()] !== undefined
          || runTokens[0].word.toLowerCase() === 'hundred');
    if (hasMagnitude && hasLeadingQuantity) {
      const value = parseNumberRun(toks.slice(i, j).map((t) => t.word));
      if (value !== null) {
        // Trim leading/trailing fillers from the highlight range so we
        // don't eat the surrounding "a" or "and" if they were standalone.
        let lo = i, hi = j - 1;
        while (lo < hi && NUM_FILLER.has(toks[lo].word.toLowerCase())) lo++;
        while (hi > lo && NUM_FILLER.has(toks[hi].word.toLowerCase())) hi--;
        ranges.push({
          start: toks[lo].start,
          end: toks[hi].end,
          value,
        });
      }
    }
    i = j;
  }

  if (ranges.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    out += text.slice(cursor, r.start);
    out += r.value.toLocaleString('en-US');
    cursor = r.end;
  }
  out += text.slice(cursor);
  return out;
}


// ---------------------------------------------------------------------------
// Block-level renderer, used by chat bubbles. Splits on newlines, classifies
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
  // Pre-pass: rewrite English number phrases into digit form for the
  // bubble. TTS receives the original text (this only runs on the
  // visible render path) so the agent still speaks the words naturally.
  text = wordedNumbersToDigits(text);
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
