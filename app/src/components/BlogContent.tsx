import { Fragment, type ReactNode } from 'react';

/**
 * Render a blog post body. Supported "markdown-lite" syntax:
 *
 *   # Heading 1                  → <h1>
 *   ## Heading 2                 → <h2>
 *   ### Heading 3                → <h3>
 *   > Quoted text                → <blockquote>
 *   --- (alone on a line)        → <hr>
 *   - / • bullet item            → <ul><li>
 *   1. numbered item             → <ol><li>
 *   blank line separates blocks
 *
 * Inline:
 *   **bold**, *italic*, `code`, [text](url)
 */

interface Props {
  content: string;
  className?: string;
  /** Typography scale. ``normal`` is the long-form blog default;
   *  ``compact`` is ~0.7× smaller and is the right pick for tight
   *  surfaces like the notification detail modal where there's
   *  limited vertical space. */
  size?: 'normal' | 'compact';
}

export function BlogContent({ content, className, size = 'normal' }: Props) {
  const blocks = parseBlocks(content || '');
  return (
    <div className={className ?? 'space-y-6 text-[#A7B0B7] leading-relaxed'}>
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b, i, size)}</Fragment>
      ))}
    </div>
  );
}


// Type-size lookup. Headings use Tailwind responsive scales so
// long-form blog reads big on desktop without overwhelming mobile.
// ``compact`` collapses to one size class, these slots already live
// inside a small modal, so the responsive bump isn't useful there.
const SIZE: Record<'normal' | 'compact', {
  h1: string; h2: string; h3: string; p: string; li: string;
}> = {
  normal: {
    h1: 'text-3xl md:text-4xl',
    h2: 'text-2xl md:text-3xl',
    h3: 'text-xl md:text-2xl',
    p: 'text-lg leading-8',
    li: 'text-lg leading-8',
  },
  compact: {
    h1: 'text-lg',
    h2: 'text-base',
    h3: 'text-sm',
    p: 'text-[13px] leading-6',
    li: 'text-[13px] leading-6',
  },
};

type Block =
  | { type: 'h'; level: 1 | 2 | 3; text: string }
  | { type: 'p'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

function parseBlocks(raw: string): Block[] {
  // Pre-normalise so headings + dividers ALWAYS sit on their own block.
  // Without this a user typing "## Heading\n- list item" (no blank
  // line between) gets the heading lumped into a paragraph because
  // ``split(/\n{2,}/)`` won't separate them. We inject blank lines
  // before/after each ``# / ## / ### `` line + each ``---`` divider,
  // then rely on the existing chunker. The inserted blanks collapse
  // away inside the chunk loop's ``.filter(Boolean)``.
  const padded = raw
    .replace(/\r\n/g, '\n')
    .replace(/(^|\n)(#{1,3} [^\n]*)/g, '$1\n\n$2\n\n')
    .replace(/(^|\n)(---|\*\*\*)\s*(?=\n|$)/g, '$1\n\n$2\n\n');

  const chunks = padded
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: Block[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // Single-line patterns
    if (lines.length === 1) {
      const line = lines[0];
      if (line === '---' || line === '***') { out.push({ type: 'hr' }); continue; }
      if (line.startsWith('### ')) { out.push({ type: 'h', level: 3, text: line.slice(4) }); continue; }
      if (line.startsWith('## ')) { out.push({ type: 'h', level: 2, text: line.slice(3) }); continue; }
      if (line.startsWith('# ')) { out.push({ type: 'h', level: 1, text: line.slice(2) }); continue; }
    }

    // Multi-line list, every line must match a bullet/numbered pattern
    const allBullet = lines.every((l) => /^(•|-|\*)\s+/.test(l));
    if (allBullet) {
      out.push({ type: 'ul', items: lines.map((l) => l.replace(/^(•|-|\*)\s+/, '')) });
      continue;
    }
    const allNumbered = lines.every((l) => /^\d+\.\s+/.test(l));
    if (allNumbered) {
      out.push({ type: 'ol', items: lines.map((l) => l.replace(/^\d+\.\s+/, '')) });
      continue;
    }

    // Quote block, every non-empty line starts with `>`
    if (lines.every((l) => l.startsWith('>'))) {
      const text = lines.map((l) => l.replace(/^>\s?/, '')).join(' ');
      out.push({ type: 'quote', text });
      continue;
    }

    // Plain paragraph (joined with single spaces, soft-wraps in source allowed)
    out.push({ type: 'p', text: lines.join(' ') });
  }
  return out;
}

function renderBlock(b: Block, key: number, size: 'normal' | 'compact'): ReactNode {
  const sz = SIZE[size];
  switch (b.type) {
    case 'h':
      if (b.level === 1) return <h1 className={`${sz.h1} font-bold text-white tracking-tight mt-2`}>{renderInline(b.text, key)}</h1>;
      if (b.level === 2) return <h2 className={`${sz.h2} font-semibold text-white tracking-tight mt-2`}>{renderInline(b.text, key)}</h2>;
      return <h3 className={`${sz.h3} font-semibold text-white tracking-tight mt-1`}>{renderInline(b.text, key)}</h3>;
    case 'p':
      return <p className={sz.p}>{renderInline(b.text, key)}</p>;
    case 'quote':
      return (
        <blockquote className={`border-l-2 border-[#DFFF00] pl-4 italic text-[#C5CAD1] ${sz.p}`}>
          {renderInline(b.text, key)}
        </blockquote>
      );
    case 'hr':
      return <hr className="border-white/10" />;
    case 'ul':
      return (
        <ul className="space-y-1.5 pl-1">
          {b.items.map((it, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="text-[#DFFF00] mt-2 leading-none">•</span>
              <span className={`flex-1 ${sz.li}`}>{renderInline(it, i)}</span>
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="space-y-1.5 pl-1">
          {b.items.map((it, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="text-[#DFFF00] font-mono shrink-0 mt-1">{i + 1}.</span>
              <span className={`flex-1 ${sz.li}`}>{renderInline(it, i)}</span>
            </li>
          ))}
        </ol>
      );
  }
}

/**
 * Tokenise inline markdown: **bold**, *italic*, `code`, [text](url).
 * Order matters, `code` first (to escape its content from other matches),
 * then `link`, then `bold`, then `italic`.
 */
function renderInline(text: string, keyBase: number | string): ReactNode[] {
  type Tok = { kind: 'text' } | { kind: 'code' | 'bold' | 'italic'; inner: string } | { kind: 'link'; inner: string; href: string };
  const tokens: (Tok & { value?: string })[] = [];

  // Single-pass tokenizer using a regex that matches any of the supported syntaxes.
  const re = /(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: 'text', value: text.slice(lastIndex, m.index) } as Tok & { value: string });
    }
    if (m[1]) tokens.push({ kind: 'code', inner: m[2] });
    else if (m[3]) tokens.push({ kind: 'link', inner: m[4], href: m[5] });
    else if (m[6]) tokens.push({ kind: 'bold', inner: m[7] });
    else if (m[8]) tokens.push({ kind: 'italic', inner: m[9] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', value: text.slice(lastIndex) } as Tok & { value: string });
  }

  return tokens.map((t, i) => {
    const k = `${keyBase}-${i}`;
    if (t.kind === 'text') return <Fragment key={k}>{(t as { value: string }).value}</Fragment>;
    if (t.kind === 'code') return <code key={k} className="rounded bg-white/10 px-1.5 py-0.5 text-[0.9em] font-mono text-[#DFFF00]">{t.inner}</code>;
    if (t.kind === 'bold') return <strong key={k} className="text-white font-semibold">{t.inner}</strong>;
    if (t.kind === 'italic') return <em key={k} className="italic">{t.inner}</em>;
    // link
    const link = t as { kind: 'link'; inner: string; href: string };
    return (
      <a
        key={k}
        href={link.href}
        target={/^https?:\/\//.test(link.href) ? '_blank' : undefined}
        rel="noopener noreferrer"
        className="text-[#DFFF00] underline-offset-2 hover:underline"
      >
        {link.inner}
      </a>
    );
  });
}
