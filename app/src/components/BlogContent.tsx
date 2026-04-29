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
}

export function BlogContent({ content, className }: Props) {
  const blocks = parseBlocks(content || '');
  return (
    <div className={className ?? 'space-y-6 text-[#A7B0B7] leading-relaxed'}>
      {blocks.map((b, i) => (
        <Fragment key={i}>{renderBlock(b, i)}</Fragment>
      ))}
    </div>
  );
}

type Block =
  | { type: 'h'; level: 1 | 2 | 3; text: string }
  | { type: 'p'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

function parseBlocks(raw: string): Block[] {
  const chunks = raw
    .replace(/\r\n/g, '\n')
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

    // Multi-line list — every line must match a bullet/numbered pattern
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

    // Quote block — every non-empty line starts with `>`
    if (lines.every((l) => l.startsWith('>'))) {
      const text = lines.map((l) => l.replace(/^>\s?/, '')).join(' ');
      out.push({ type: 'quote', text });
      continue;
    }

    // Plain paragraph (joined with single spaces — soft-wraps in source allowed)
    out.push({ type: 'p', text: lines.join(' ') });
  }
  return out;
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.type) {
    case 'h':
      if (b.level === 1) return <h1 className="text-3xl md:text-4xl font-bold text-white tracking-tight mt-2">{renderInline(b.text, key)}</h1>;
      if (b.level === 2) return <h2 className="text-2xl md:text-3xl font-semibold text-white tracking-tight mt-2">{renderInline(b.text, key)}</h2>;
      return <h3 className="text-xl md:text-2xl font-semibold text-white tracking-tight mt-1">{renderInline(b.text, key)}</h3>;
    case 'p':
      return <p className="text-lg leading-8">{renderInline(b.text, key)}</p>;
    case 'quote':
      return (
        <blockquote className="border-l-2 border-[#DFFF00] pl-4 italic text-[#C5CAD1]">
          {renderInline(b.text, key)}
        </blockquote>
      );
    case 'hr':
      return <hr className="border-white/10" />;
    case 'ul':
      return (
        <ul className="space-y-2 pl-1">
          {b.items.map((it, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="text-[#DFFF00] mt-2 leading-none">•</span>
              <span className="flex-1 text-lg leading-8">{renderInline(it, i)}</span>
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="space-y-2 pl-1">
          {b.items.map((it, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="text-[#DFFF00] font-mono shrink-0 mt-1">{i + 1}.</span>
              <span className="flex-1 text-lg leading-8">{renderInline(it, i)}</span>
            </li>
          ))}
        </ol>
      );
  }
}

/**
 * Tokenise inline markdown: **bold**, *italic*, `code`, [text](url).
 * Order matters — `code` first (to escape its content from other matches),
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
