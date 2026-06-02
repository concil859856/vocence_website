/**
 * Agent Knowledge panel, manages external knowledge sources attached
 * to one agent. Lives in the Settings tab.
 *
 * Source types supported:
 *   • PDF upload (multipart)
 *   • URL (single page or one-hop crawl)
 *   • Sitemap (with include/exclude globs)
 *   • Plain text and Markdown (inline content)
 *
 * The backend proxies each ingest to the ``vocence/knowledge-ingestion``
 * pod. Small text/markdown bodies return ``status:"completed"``
 * synchronously; everything else returns a ``job_id`` we poll.
 *
 * Errors that the pod isn't deployed surface as a clear inline notice —
 * we hide the upload UI in that case so the user doesn't try and fail.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, Database, FileText, Globe, Loader2, Map,
  Plus, Trash2, Upload,
} from 'lucide-react';
import { dashboardApi, type KnowledgeSource, type KnowledgeIngestResponse } from '../../services/dashboardApi';
import { useConfirm } from '../../hooks/useConfirm';

type SourceKind = 'pdf' | 'url' | 'sitemap' | 'text' | 'markdown';

interface Props {
  agentId: string;
  token: string | null;
}

interface PendingJob {
  jobId: string;
  startedAt: number;
  label: string;
}

interface FailedJob {
  jobId: string;
  label: string;
  reason: string;
}


export function AgentKnowledgePanel({ agentId, token }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingJobs, setPendingJobs] = useState<PendingJob[]>([]);
  // Surfaces async ingest failures (URL fetch 404, sitemap parse error,
  // PDF OCR crash, …). Without this the polling loop silently dropped
  // failed jobs and the user saw an empty source list, with no idea
  // their ingest had actually been attempted and failed.
  const [failedJobs, setFailedJobs] = useState<FailedJob[]>([]);

  const refresh = useCallback(async () => {
    try {
      const r = await dashboardApi.listAgentKnowledgeSources(agentId, token);
      setSources(r.sources);
      setError(null);
      setUnsupported(false);
    } catch (e) {
      // The dashboard returns 503 with code=knowledge_unconfigured when
      // the pod isn't deployed. Hide the UI in that case rather than
      // showing a confusing generic error.
      const msg = (e as Error).message || '';
      if (msg.includes('knowledge_unconfigured')) {
        setUnsupported(true);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [agentId, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll in-flight ingest jobs every 2s until each one finishes. On
  // completion → refresh the sources list. On failure → move the job
  // to ``failedJobs`` so the user sees a red banner with the reason
  // (previously the failure was silently dropped, the user saw an
  // empty list and assumed the request never happened).
  useEffect(() => {
    if (pendingJobs.length === 0) return;
    const interval = window.setInterval(async () => {
      const stillPending: PendingJob[] = [];
      const newlyFailed: FailedJob[] = [];
      for (const job of pendingJobs) {
        try {
          const status = await dashboardApi.getAgentKnowledgeJob(agentId, job.jobId, token);
          if (status.status === 'completed') {
            void refresh();
          } else if (status.status === 'failed') {
            newlyFailed.push({
              jobId: job.jobId,
              label: job.label,
              // The pod returns a structured ``error`` field with the
              // root cause (HTTP status, parse error, etc.). Surface
              // whatever it gave us, fall back to a generic string.
              reason: status.error || status.message || 'Ingestion failed',
            });
          } else {
            // Still running; keep polling.
            stillPending.push(job);
          }
        } catch {
          // Polling network failure (pod restart, brief proxy blip) —
          // keep the job in the pending queue and try again on the
          // next tick.
          stillPending.push(job);
        }
      }
      if (stillPending.length !== pendingJobs.length) {
        setPendingJobs(stillPending);
      }
      if (newlyFailed.length > 0) {
        setFailedJobs((prev) => [...prev, ...newlyFailed]);
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [pendingJobs, agentId, token, refresh]);

  const handleIngestResult = (
    label: string, r: KnowledgeIngestResponse,
  ) => {
    if (r.status === 'completed') {
      void refresh();
    } else if (r.job_id) {
      setPendingJobs((prev) => [...prev, {
        jobId: r.job_id!, startedAt: Date.now(), label,
      }]);
    }
    setShowAdd(false);
  };

  const handleDelete = async (sourceId: string, title: string) => {
    const ok = await confirm({
      title: 'Delete knowledge source?',
      message: `"${title}" will be removed from this agent's knowledge base, and its chunks will be deleted on the next index sync. This can't be undone.`,
      confirmLabel: 'Delete source',
      cancelLabel: 'Keep it',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    try {
      await dashboardApi.deleteAgentKnowledgeSource(agentId, sourceId, token);
      setSources((prev) => prev.filter((s) => s.source_id !== sourceId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (unsupported) {
    return (
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="flex items-start gap-3">
          <Database size={18} className="text-[#A7B0B7] shrink-0 mt-0.5" />
          <div>
            <h3 className="text-white font-semibold mb-1">External knowledge</h3>
            <p className="text-sm text-[#A7B0B7] leading-relaxed">
              External knowledge ingestion isn't configured for this deployment.
              The free-text knowledge field above is still active. Ask your
              admin to deploy the <span className="font-mono text-xs">vocence/knowledge-ingestion</span> pod
              to enable PDF / URL / sitemap uploads.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Database size={16} className="text-[#A7B0B7]" />
          <h3 className="text-white font-semibold">External knowledge</h3>
          <span className="text-[11px] text-[#A7B0B7]">
            PDF, URL, sitemap, or text, searched per turn at runtime
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border border-[#DFFF00]/30 bg-[#DFFF00]/[0.08] text-[#DFFF00] hover:bg-[#DFFF00]/[0.18]"
        >
          <Plus size={13} /> Add source
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {showAdd && (
        <AddSourceForm
          agentId={agentId}
          token={token}
          onCancel={() => setShowAdd(false)}
          onResult={handleIngestResult}
        />
      )}

      {pendingJobs.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300/25 bg-amber-300/[0.05] px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-amber-200 mb-1">
            Ingesting… (typically 5–30 s; you can leave this page)
          </div>
          {pendingJobs.map((j) => (
            <div key={j.jobId} className="flex items-center gap-2 text-xs text-amber-100 py-0.5">
              <Loader2 size={12} className="animate-spin" />
              <span className="truncate">{j.label}</span>
            </div>
          ))}
        </div>
      )}

      {failedJobs.length > 0 && (
        <div className="mb-3 rounded-lg border border-red-400/30 bg-red-500/[0.06] px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase tracking-wider text-red-300">
              Ingestion failed
            </div>
            <button
              type="button"
              onClick={() => setFailedJobs([])}
              className="text-[10px] uppercase tracking-wider text-red-200/70 hover:text-red-100"
            >
              Dismiss
            </button>
          </div>
          {failedJobs.map((j) => (
            <div key={j.jobId} className="text-xs text-red-100 py-0.5">
              <span className="font-semibold">{j.label}</span>
              <span className="text-red-200/85">, {j.reason}</span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[#A7B0B7]">Loading…</p>
      ) : sources.length === 0 && !showAdd ? (
        <p className="text-sm text-[#A7B0B7]">
          No external sources attached. Click <span className="text-[#DFFF00]">Add source</span> to
          upload a PDF, URL, sitemap, or paste in text.
        </p>
      ) : sources.length > 0 ? (
        <div className="border border-white/10 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-[#A7B0B7]">
              <tr>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-right px-3 py-2">Chunks</th>
                <th className="text-left px-3 py-2">Ingested</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sources.map((s) => (
                <tr key={s.source_id} className="hover:bg-white/[0.02]">
                  <td className="px-3 py-2 text-white">
                    <div className="truncate max-w-[420px]">{s.source_title || s.source_id}</div>
                    <div className="text-[10px] text-[#666] font-mono">{s.source_id}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-white">{s.chunks}</td>
                  <td className="px-3 py-2 text-[#A7B0B7] text-xs">{s.ingested_at}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void handleDelete(s.source_id, s.source_title)}
                      className="p-1.5 text-red-300 hover:text-red-200 hover:bg-red-500/[0.08] rounded"
                      title="Delete source"
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {confirmDialog}
    </section>
  );
}


function AddSourceForm({
  agentId, token, onCancel, onResult,
}: {
  agentId: string;
  token: string | null;
  onCancel: () => void;
  onResult: (label: string, r: KnowledgeIngestResponse) => void;
}) {
  const [kind, setKind] = useState<SourceKind>('text');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // Per-kind form state, declared at top level so React doesn't churn
  // them as the user toggles kind.
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [maxDepth, setMaxDepth] = useState<0 | 1>(0);
  const [includePatterns, setIncludePatterns] = useState('');
  const [excludePatterns, setExcludePatterns] = useState('');
  const [maxPages, setMaxPages] = useState(100);
  const [file, setFile] = useState<File | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const label = title.trim() || (
        kind === 'pdf' ? (file?.name ?? 'PDF') :
        kind === 'url' ? url :
        kind === 'sitemap' ? url :
        kind === 'text' ? 'Text source' : 'Markdown source'
      );
      let result: KnowledgeIngestResponse;
      if (kind === 'pdf') {
        if (!file) { setError('Pick a file first.'); setBusy(false); return; }
        result = await dashboardApi.ingestAgentKnowledgePdf(agentId, {
          file, title: title.trim() || file.name,
        }, token);
      } else if (kind === 'url') {
        if (!url.trim()) { setError('URL is required.'); setBusy(false); return; }
        result = await dashboardApi.ingestAgentKnowledgeUrl(agentId, {
          url: url.trim(), title: title.trim() || undefined, max_depth: maxDepth,
        }, token);
      } else if (kind === 'sitemap') {
        if (!url.trim()) { setError('Sitemap URL is required.'); setBusy(false); return; }
        result = await dashboardApi.ingestAgentKnowledgeSitemap(agentId, {
          url: url.trim(), title: title.trim() || undefined,
          include: parseLines(includePatterns),
          exclude: parseLines(excludePatterns),
          max_pages: maxPages,
        }, token);
      } else if (kind === 'text') {
        if (!text.trim()) { setError('Paste some text first.'); setBusy(false); return; }
        result = await dashboardApi.ingestAgentKnowledgeText(agentId, {
          content: text, title: title.trim() || undefined,
        }, token);
      } else {
        if (!text.trim()) { setError('Paste some markdown first.'); setBusy(false); return; }
        result = await dashboardApi.ingestAgentKnowledgeMarkdown(agentId, {
          content: text, title: title.trim() || undefined,
        }, token);
      }
      onResult(label, result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 rounded-xl border border-white/10 bg-[#07080A]/60 p-4 space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        {(['text', 'markdown', 'url', 'sitemap', 'pdf'] as SourceKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${
              kind === k
                ? 'border-[#DFFF00]/40 bg-[#DFFF00]/[0.10] text-[#DFFF00]'
                : 'border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20'
            }`}
          >
            {kindIcon(k)}
            {k.charAt(0).toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional, displayed in source list)"
        className="w-full rounded-lg bg-[#0a0a0a] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#666] focus:outline-none focus:border-white/30"
      />

      {(kind === 'text' || kind === 'markdown') && (
        <textarea
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={kind === 'markdown' ? '# Heading\n\nSome content...' : 'Paste plain text here…'}
          className="w-full rounded-lg bg-[#0a0a0a] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#666] focus:outline-none focus:border-white/30 font-mono"
        />
      )}

      {kind === 'url' && (
        <>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.example.com/getting-started"
            className="w-full rounded-lg bg-[#0a0a0a] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#666] focus:outline-none focus:border-white/30"
          />
          <label className="flex items-center gap-2 text-xs text-[#A7B0B7]">
            <input
              type="checkbox"
              checked={maxDepth === 1}
              onChange={(e) => setMaxDepth(e.target.checked ? 1 : 0)}
              className="accent-[#DFFF00] w-3.5 h-3.5 rounded"
            />
            Crawl same-origin links one hop deep (up to 20 pages)
          </label>
        </>
      )}

      {kind === 'sitemap' && (
        <>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.example.com/sitemap.xml"
            className="w-full rounded-lg bg-[#0a0a0a] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#666] focus:outline-none focus:border-white/30"
          />
          <div className="grid grid-cols-2 gap-3">
            <textarea
              rows={3}
              value={includePatterns}
              onChange={(e) => setIncludePatterns(e.target.value)}
              placeholder={"Include globs (one per line)\ne.g. /docs/*"}
              className="rounded-lg bg-[#0a0a0a] border border-white/10 px-3 py-2 text-xs text-white placeholder-[#666] font-mono focus:outline-none focus:border-white/30"
            />
            <textarea
              rows={3}
              value={excludePatterns}
              onChange={(e) => setExcludePatterns(e.target.value)}
              placeholder={"Exclude globs (one per line)\ne.g. /docs/internal/*"}
              className="rounded-lg bg-[#0a0a0a] border border-white/10 px-3 py-2 text-xs text-white placeholder-[#666] font-mono focus:outline-none focus:border-white/30"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-[#A7B0B7]">
            Max pages
            <input
              type="number"
              min={1}
              max={1000}
              value={maxPages}
              onChange={(e) => setMaxPages(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))}
              className="rounded-md bg-[#0a0a0a] border border-white/10 px-2 py-1 w-24 text-white"
            />
          </label>
        </>
      )}

      {kind === 'pdf' && (
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm text-[#A7B0B7] file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-white/[0.06] file:text-white hover:file:bg-white/[0.12]"
        />
      )}

      {error && (
        <p className="text-xs text-red-300 flex items-center gap-1.5">
          <AlertCircle size={11} /> {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-sm text-[#A7B0B7] hover:text-white px-3 py-1.5"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#DFFF00] text-[#07080A] px-3.5 py-1.5 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          {busy ? 'Uploading…' : 'Ingest'}
        </button>
      </div>
    </div>
  );
}


function kindIcon(k: SourceKind) {
  const size = 12;
  if (k === 'pdf') return <FileText size={size} />;
  if (k === 'url') return <Globe size={size} />;
  if (k === 'sitemap') return <Map size={size} />;
  return <FileText size={size} />;
}


function parseLines(s: string): string[] | undefined {
  const arr = s.split(/\n/).map((x) => x.trim()).filter(Boolean);
  return arr.length > 0 ? arr : undefined;
}
