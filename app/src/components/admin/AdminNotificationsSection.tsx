/**
 * AdminNotificationsSection, compose + send notifications to users.
 *
 * Now with the same markdown-lite editor surface the Blog editor uses:
 *   * Toolbar with H1/H2/H3, bold, italic, inline code, link, lists, quote, divider
 *   * Edit / Split / Preview mode toggle
 *   * Cmd/Ctrl + B / I keyboard shortcuts
 *   * Live preview rendered via BlogContent so the admin sees exactly
 *     what users will see in the notification detail modal
 *
 * Audience choice (all / premium / specific user_ids) drives one row
 * per recipient on the backend so unread state is per-user even for
 * broadcasts (see notifications.py:admin_send).
 */

import { useMemo, useRef, useState } from 'react';
import {
  Bold,
  Code as CodeIcon,
  Edit3,
  Eye,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Minus,
  Quote,
  Send,
  X as XIcon,
} from 'lucide-react';
import { dashboardApi } from '../../services/dashboardApi';
import { BlogContent } from '../BlogContent';
import { toast } from 'sonner';


type Audience = 'all' | 'premium' | 'user_ids';
type EditorMode = 'edit' | 'split' | 'preview';


export function AdminNotificationsSection() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [audience, setAudience] = useState<Audience>('all');
  const [userIdsRaw, setUserIdsRaw] = useState('');
  const [sending, setSending] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>('split');
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  // Markdown helpers, shape-identical to the Admin blog editor so the
  // mental model carries over for anyone who's used either.
  const applyEdit = (
    op: { mode: 'wrap'; before: string; after: string; placeholder?: string }
      | { mode: 'linePrefix'; before: string }
      | { mode: 'block'; snippet: string }
  ) => {
    const ta = bodyRef.current;
    if (!ta) return;
    const value = ta.value;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    let next: string;
    let cursor: number;

    if (op.mode === 'wrap') {
      const sel = value.slice(start, end) || (op.placeholder ?? '');
      next = value.slice(0, start) + op.before + sel + op.after + value.slice(end);
      cursor = start + op.before.length + sel.length + op.after.length;
    } else if (op.mode === 'linePrefix') {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = value.indexOf('\n', end);
      const slice = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);
      const prefixed = slice
        .split('\n')
        .map((ln) => (ln.startsWith(op.before) ? ln : op.before + ln))
        .join('\n');
      next = value.slice(0, lineStart) + prefixed + (lineEnd === -1 ? '' : value.slice(lineEnd));
      cursor = lineStart + prefixed.length;
    } else {
      const needsLead = start > 0 && value[start - 1] !== '\n';
      const needsTrail = end < value.length && value[end] !== '\n';
      const inject = (needsLead ? '\n\n' : '\n') + op.snippet + (needsTrail ? '\n\n' : '\n');
      next = value.slice(0, start) + inject + value.slice(end);
      cursor = start + inject.length;
    }

    setBody(next);
    // Restore cursor + focus after React's re-render. setTimeout 0 lets
    // the textarea get its new value first.
    setTimeout(() => {
      const t = bodyRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(cursor, cursor);
    }, 0);
  };

  const handleSend = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) { toast.error('Title is required'); return; }
    const userIds = userIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (audience === 'user_ids' && userIds.length === 0) {
      toast.error('Add at least one user id');
      return;
    }
    if (!window.confirm(`Send to ${audience === 'user_ids' ? userIds.length + ' user(s)' : audience}?`)) return;
    setSending(true);
    try {
      const res = await dashboardApi.adminSendNotification({
        title: trimmedTitle,
        body: body.trim(),
        link: link.trim() || null,
        image_url: imageUrl.trim() || null,
        audience,
        user_ids: audience === 'user_ids' ? userIds : undefined,
      });
      toast.success(`Sent to ${res.sent} recipient${res.sent === 1 ? '' : 's'}`);
      setTitle('');
      setBody('');
      setLink('');
      setImageUrl('');
      setUserIdsRaw('');
    } catch (e) {
      toast.error('Send failed', { description: (e as { userMessage?: string })?.userMessage });
    } finally {
      setSending(false);
    }
  };

  const charCount = body.length;
  const wordCount = useMemo(() => body.trim().split(/\s+/).filter(Boolean).length, [body]);

  const handleImageUpload = async (file: File) => {
    if (file.size > 4 * 1024 * 1024) {
      toast.error('Image too large', { description: 'Max 4 MB.' });
      return;
    }
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      toast.error('Use a JPG, PNG, WebP, or GIF');
      return;
    }
    setUploadingImage(true);
    try {
      const res = await dashboardApi.adminUploadNotificationImage(file);
      setImageUrl(res.url);
      toast.success('Image uploaded');
    } catch (e) {
      toast.error('Upload failed', { description: (e as { userMessage?: string })?.userMessage });
    } finally {
      setUploadingImage(false);
    }
  };

  return (
    <section className="glass-panel rounded-xl p-6 mb-8">
      <div className="mb-4">
        <h2 className="text-xl font-semibold text-white">Send notification</h2>
        <p className="text-xs text-white/55 mt-0.5">
          Compose with markdown · users see this in their inbox detail modal.
        </p>
      </div>

      <div className="grid gap-4">
        {/* Title */}
        <div>
          <label className="block text-xs text-white/55 mb-1.5">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="e.g. New voice released"
            className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#DFFF00]/30"
          />
          <div className="text-[10px] text-white/35 mt-1 text-right tabular-nums">{title.length}/120</div>
        </div>

        {/* Body, rich markdown editor */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-white/55">Body</label>
            <div className="flex items-center gap-2 text-[11px] text-white/45">
              <span className="tabular-nums">{wordCount.toLocaleString()} words · {charCount.toLocaleString()} chars</span>
              <div className="inline-flex rounded-md border border-[#27272a] overflow-hidden">
                {([
                  { id: 'edit', icon: Edit3, label: 'Edit' },
                  { id: 'split', icon: () => null, label: 'Split' },
                  { id: 'preview', icon: Eye, label: 'Preview' },
                ] as const).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setEditorMode(m.id)}
                    className={`px-2.5 py-1 text-[11px] transition-colors ${
                      editorMode === m.id ? 'bg-[#DFFF00] text-[#07080A] font-semibold' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 rounded-t-lg border border-b-0 border-[#27272a] bg-[#0a0a0a]">
            <ToolbarBtn label="Heading 1" onClick={() => applyEdit({ mode: 'linePrefix', before: '# ' })}><Heading1 className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Heading 2" onClick={() => applyEdit({ mode: 'linePrefix', before: '## ' })}><Heading2 className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Heading 3" onClick={() => applyEdit({ mode: 'linePrefix', before: '### ' })}><Heading3 className="w-4 h-4" /></ToolbarBtn>
            <ToolbarSep />
            <ToolbarBtn label="Bold" onClick={() => applyEdit({ mode: 'wrap', before: '**', after: '**', placeholder: 'bold text' })}><Bold className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Italic" onClick={() => applyEdit({ mode: 'wrap', before: '*', after: '*', placeholder: 'italic text' })}><Italic className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Inline code" onClick={() => applyEdit({ mode: 'wrap', before: '`', after: '`', placeholder: 'code' })}><CodeIcon className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Link" onClick={() => {
              const url = window.prompt('Link URL', 'https://');
              if (url) applyEdit({ mode: 'wrap', before: '[', after: `](${url})`, placeholder: 'link text' });
            }}><LinkIcon className="w-4 h-4" /></ToolbarBtn>
            <ToolbarSep />
            <ToolbarBtn label="Bullet list" onClick={() => applyEdit({ mode: 'linePrefix', before: '- ' })}><List className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Numbered list" onClick={() => applyEdit({ mode: 'linePrefix', before: '1. ' })}><ListOrdered className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Quote" onClick={() => applyEdit({ mode: 'linePrefix', before: '> ' })}><Quote className="w-4 h-4" /></ToolbarBtn>
            <ToolbarBtn label="Divider" onClick={() => applyEdit({ mode: 'block', snippet: '---' })}><Minus className="w-4 h-4" /></ToolbarBtn>
          </div>

          {/* Editor + preview surfaces */}
          <div className={
            editorMode === 'split'
              ? 'grid grid-cols-1 lg:grid-cols-2 gap-0 border border-[#27272a] rounded-b-lg overflow-hidden'
              : 'border border-[#27272a] rounded-b-lg overflow-hidden'
          }>
            {(editorMode === 'edit' || editorMode === 'split') && (
              <textarea
                ref={bodyRef}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
                    e.preventDefault();
                    applyEdit({ mode: 'wrap', before: '**', after: '**', placeholder: 'bold text' });
                  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
                    e.preventDefault();
                    applyEdit({ mode: 'wrap', before: '*', after: '*', placeholder: 'italic text' });
                  }
                }}
                placeholder="The body the user sees inside the notification detail modal. Supports **bold**, *italic*, `code`, [links](https://example.com), bullet/numbered lists, quotes, and dividers."
                className={
                  'w-full min-h-[260px] px-5 py-4 bg-[#0f0f0f] text-white text-[14px] leading-7 placeholder-white/35 resize-y outline-none focus:bg-[#0c0c0c] ' +
                  (editorMode === 'split' ? 'lg:border-r border-[#27272a]' : '')
                }
              />
            )}
            {(editorMode === 'preview' || editorMode === 'split') && (
              <div className="min-h-[260px] px-5 py-4 bg-[#0c0c0c] overflow-y-auto">
                {body.trim() ? (
                  <BlogContent
                    content={body}
                    size="compact"
                    className="space-y-2.5 text-white/80"
                  />
                ) : (
                  <p className="text-xs text-white/35 italic">Preview appears here as you type.</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Link */}
        <div>
          <label className="block text-xs text-white/55 mb-1.5">Link (optional)</label>
          <input
            type="text"
            value={link}
            onChange={(e) => setLink(e.target.value)}
            maxLength={500}
            placeholder="e.g. /studio/community-voices"
            className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#DFFF00]/30"
          />
          <p className="text-[10px] text-white/40 mt-1">In-app path. The detail modal shows a "Go to page" CTA pointing here.</p>
        </div>

        {/* Image, upload or paste a URL, optional. When set, the
            user's detail modal renders it as a banner above the title.
            Empty = no image area, no placeholder. */}
        <div>
          <label className="block text-xs text-white/55 mb-1.5">Banner image (optional)</label>
          <div className="flex flex-wrap gap-2 items-stretch">
            <label
              className={
                'inline-flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[#27272a] text-sm cursor-pointer ' +
                (uploadingImage ? 'text-white/40 cursor-wait' : 'text-white/65 hover:text-white hover:bg-white/[0.04]')
              }
            >
              {uploadingImage
                ? <><Loader2 size={14} className="animate-spin" /> Uploading…</>
                : <><ImagePlus size={14} /> Upload</>}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                disabled={uploadingImage}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleImageUpload(f);
                  e.target.value = '';
                }}
              />
            </label>
            <input
              type="text"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              maxLength={500}
              placeholder="or paste an image URL, https://example.com/banner.jpg"
              className="flex-1 min-w-[180px] bg-[#0f0f0f] border border-[#27272a] rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#DFFF00]/30"
            />
            {imageUrl.trim() && (
              <div className="relative shrink-0 w-20 h-20 rounded-lg border border-[#27272a] bg-[#0f0f0f] overflow-hidden group">
                <img
                  src={imageUrl.trim()}
                  alt="preview"
                  className="w-full h-full object-cover"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0.2'; }}
                />
                <button
                  type="button"
                  onClick={() => setImageUrl('')}
                  className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity text-white"
                  title="Remove image"
                  aria-label="Remove image"
                >
                  <XIcon size={16} />
                </button>
              </div>
            )}
          </div>
          <p className="text-[10px] text-white/40 mt-1">Uploads land in our bucket and we serve a permanent URL. Or paste any public URL.</p>
        </div>

        {/* Audience */}
        <div>
          <label className="block text-xs text-white/55 mb-1.5">Audience</label>
          <div className="flex gap-2 flex-wrap">
            {(['all', 'premium', 'user_ids'] as Audience[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setAudience(a)}
                className={
                  'text-xs px-3.5 py-1.5 rounded-full border transition-colors ' +
                  (audience === a
                    ? 'bg-[#DFFF00]/15 border-[#DFFF00]/40 text-[#DFFF00]'
                    : 'border-[#27272a] text-white/65 hover:text-white hover:bg-white/[0.04]')
                }
              >
                {a === 'user_ids' ? 'specific users' : a}
              </button>
            ))}
          </div>
        </div>

        {audience === 'user_ids' && (
          <div>
            <label className="block text-xs text-white/55 mb-1.5">User ids (comma or newline separated)</label>
            <textarea
              value={userIdsRaw}
              onChange={(e) => setUserIdsRaw(e.target.value)}
              rows={3}
              placeholder="107814737358916029833&#10;104821736658916011234"
              className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-4 py-2.5 text-sm text-white font-mono focus:outline-none focus:border-[#DFFF00]/30 resize-y"
            />
          </div>
        )}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#DFFF00] text-[#07080A] px-5 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_4px_14px_-2px_rgba(223,255,0,0.35)]"
          >
            {sending ? <><Loader2 size={14} className="animate-spin" /> Sending…</> : <><Send size={14} /> Send</>}
          </button>
        </div>
      </div>
    </section>
  );
}


/* -------------------------- Toolbar primitives -------------------------- */

function ToolbarBtn({
  label, onClick, children,
}: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex items-center justify-center w-8 h-8 rounded text-white/65 hover:text-white hover:bg-white/[0.06] transition-colors"
    >
      {children}
    </button>
  );
}

function ToolbarSep() {
  return <span className="w-px h-5 bg-[#27272a] mx-0.5" aria-hidden />;
}
