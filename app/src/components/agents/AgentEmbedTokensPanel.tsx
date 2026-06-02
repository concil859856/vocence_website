/**
 * Embed-token issuance + management panel for one agent.
 *
 * Agent owners mint a token here, copy the resulting one-line embed
 * snippet, and paste it into their own website. Sessions opened with
 * that token bill against the owner's account.
 *
 * The plaintext token is shown EXACTLY ONCE in the issuance modal —
 * subsequent reads (the list view) only see the prefix. Same pattern
 * as the developer API keys page.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle, Check, Code, Copy, KeyRound, Loader2, Plus, Trash2,
} from 'lucide-react';
import { dashboardApi, type EmbedTokenRow } from '../../services/dashboardApi';
import { useConfirm } from '../../hooks/useConfirm';


interface Props {
  agentId: string;
  token: string | null;
}


export function AgentEmbedTokensPanel({ agentId, token }: Props) {
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [rows, setRows] = useState<EmbedTokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // The "just-minted" plaintext + snippet, shown once in a modal
  // after the create call returns.
  const [justMinted, setJustMinted] = useState<{
    plaintext: string;
    snippet: string;
    row: EmbedTokenRow;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await dashboardApi.listAgentEmbedTokens(agentId, token);
      setRows(r.tokens);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleRevoke = async (tokenId: string, label: string) => {
    const ok = await confirm({
      title: 'Revoke this embed token?',
      message:
        `"${label}" will be revoked immediately. Any website still using this token in the ` +
        `<vocence-agent> widget will start failing to open sessions, you'll need to mint a new ` +
        `token and update those sites.`,
      confirmLabel: 'Revoke token',
      cancelLabel: 'Keep it',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    try {
      await dashboardApi.revokeAgentEmbedToken(agentId, tokenId, token);
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-[#A7B0B7]" />
          <h3 className="text-white font-semibold">Embed widget</h3>
          <span className="text-[11px] text-[#A7B0B7]">
            Generate a token to drop this agent into any website
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border border-[#DFFF00]/30 bg-[#DFFF00]/[0.08] text-[#DFFF00] hover:bg-[#DFFF00]/[0.18]"
        >
          <Plus size={13} /> New embed token
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[#A7B0B7]">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[#A7B0B7]">
          No embed tokens yet. Generate one to paste the agent into a customer-facing site.
          Sessions opened via the token bill against your account.
        </p>
      ) : (
        <div className="border border-white/10 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-[#A7B0B7]">
              <tr>
                <th className="text-left px-3 py-2">Label</th>
                <th className="text-left px-3 py-2">Token</th>
                <th className="text-left px-3 py-2">Origins</th>
                <th className="text-right px-3 py-2">Rate</th>
                <th className="text-left px-3 py-2">Last used</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => {
                const revoked = !!r.revoked_at;
                return (
                  <tr
                    key={r.id}
                    className={`hover:bg-white/[0.02] ${revoked ? 'opacity-50' : ''}`}
                  >
                    <td className="px-3 py-2 text-white">
                      {r.label || <span className="text-[#666]">(no label)</span>}
                      {revoked && (
                        <span className="ml-2 text-[9px] uppercase tracking-wider bg-red-500/20 text-red-200 border border-red-400/30 rounded px-1.5 py-0.5">
                          Revoked
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[#A7B0B7]">{r.token_prefix}…</td>
                    <td className="px-3 py-2 text-[#A7B0B7] text-xs">
                      {r.allowed_origins.length === 0 ? <em>any</em> : r.allowed_origins.join(', ')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#A7B0B7] text-xs">
                      {r.rate_limit_per_ip_per_hour}/h · {r.max_session_minutes}m
                    </td>
                    <td className="px-3 py-2 text-[#A7B0B7] text-xs">
                      {r.last_used_at ?? <span className="text-[#666]">never</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!revoked && (
                        <button
                          type="button"
                          onClick={() => void handleRevoke(r.id, r.label || r.token_prefix)}
                          className="p-1.5 text-red-300 hover:text-red-200 hover:bg-red-500/[0.08] rounded"
                          title="Revoke"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateTokenModal
          agentId={agentId}
          token={token}
          onCancel={() => setShowCreate(false)}
          onCreated={(plaintext, snippet, row) => {
            setShowCreate(false);
            setJustMinted({ plaintext, snippet, row });
            void refresh();
          }}
        />
      )}

      {justMinted && (
        <RevealTokenModal
          plaintext={justMinted.plaintext}
          snippet={justMinted.snippet}
          row={justMinted.row}
          onClose={() => setJustMinted(null)}
        />
      )}
      {confirmDialog}
    </section>
  );
}


function CreateTokenModal({
  agentId, token, onCancel, onCreated,
}: {
  agentId: string;
  token: string | null;
  onCancel: () => void;
  onCreated: (plaintext: string, snippet: string, row: EmbedTokenRow) => void;
}) {
  const [label, setLabel] = useState('');
  const [originsText, setOriginsText] = useState('');
  const [rateLimit, setRateLimit] = useState(30);
  const [maxSessionMinutes, setMaxSessionMinutes] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const allowed_origins = originsText
        .split(/\n/).map((s) => s.trim()).filter(Boolean);
      const r = await dashboardApi.createAgentEmbedToken(agentId, {
        label: label.trim() || undefined,
        allowed_origins,
        rate_limit_per_ip_per_hour: rateLimit,
        max_session_minutes: maxSessionMinutes,
      }, token);
      onCreated(r.plaintext, r.embed_snippet, r.token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d0e10] border border-white/15 rounded-2xl max-w-lg w-full p-5 space-y-3">
        <h3 className="text-white font-semibold">New embed token</h3>
        <p className="text-xs text-[#A7B0B7] leading-relaxed">
          The plaintext token is shown once after creation. Save it then, we
          store only a hash and won't be able to retrieve it later.
        </p>

        <label className="block">
          <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">Label</div>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. docs.example.com production"
            className="w-full bg-[#07080A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-[#666] focus:outline-none focus:border-white/30"
          />
        </label>

        <label className="block">
          <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">
            Allowed origins (one per line; blank = any)
          </div>
          <textarea
            rows={3}
            value={originsText}
            onChange={(e) => setOriginsText(e.target.value)}
            placeholder={'docs.example.com\n*.example.com'}
            className="w-full bg-[#07080A] border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-[#666] font-mono focus:outline-none focus:border-white/30"
          />
          <div className="text-[10px] text-[#666] mt-1">
            Use <span className="font-mono">*.example.com</span> to match subdomains.
            Leave blank to allow embedding on any origin (less secure).
          </div>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">Sessions / IP / hour</div>
            <input
              type="number" min={1} max={10000}
              value={rateLimit}
              onChange={(e) => setRateLimit(Math.max(1, Math.min(10000, Number(e.target.value) || 30)))}
              className="w-full bg-[#07080A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
            />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">Max session (min)</div>
            <input
              type="number" min={1} max={60}
              value={maxSessionMinutes}
              onChange={(e) => setMaxSessionMinutes(Math.max(1, Math.min(60, Number(e.target.value) || 5)))}
              className="w-full bg-[#07080A] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-white/30"
            />
          </label>
        </div>

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
            {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
            {busy ? 'Generating…' : 'Generate token'}
          </button>
        </div>
      </div>
    </div>
  );
}


function RevealTokenModal({
  plaintext, snippet, row, onClose,
}: {
  plaintext: string;
  snippet: string;
  row: EmbedTokenRow;
  onClose: () => void;
}) {
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const copy = async (text: string, which: 'token' | 'snippet') => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'token') {
        setCopiedToken(true);
        window.setTimeout(() => setCopiedToken(false), 1500);
      } else {
        setCopiedSnippet(true);
        window.setTimeout(() => setCopiedSnippet(false), 1500);
      }
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d0e10] border border-[#DFFF00]/30 rounded-2xl max-w-2xl w-full p-5 space-y-4">
        <div>
          <h3 className="text-white font-semibold flex items-center gap-2">
            <KeyRound size={16} className="text-[#DFFF00]" /> Token created
          </h3>
          <p className="text-xs text-amber-200 mt-1 leading-relaxed">
            ⚠ This is the only time the plaintext will be shown. Copy it and store it
            somewhere safe.
          </p>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">Plaintext token</div>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 bg-[#07080A] border border-white/10 rounded-lg px-3 py-2 text-sm font-mono break-all text-[#DFFF00]">
              {plaintext}
            </code>
            <button
              type="button"
              onClick={() => void copy(plaintext, 'token')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs text-white hover:bg-white/[0.05]"
            >
              {copiedToken ? <Check size={13} /> : <Copy size={13} />}
              {copiedToken ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1 flex items-center gap-1.5">
            <Code size={11} /> Embed snippet
          </div>
          <pre className="bg-[#07080A] border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-[#C5CAD1] whitespace-pre-wrap break-all">
{snippet}
          </pre>
          <button
            type="button"
            onClick={() => void copy(snippet, 'snippet')}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/[0.05]"
          >
            {copiedSnippet ? <Check size={12} /> : <Copy size={12} />}
            {copiedSnippet ? 'Copied' : 'Copy snippet'}
          </button>
        </div>

        <div className="text-[11px] text-[#A7B0B7] border-t border-white/10 pt-3">
          <div>Allowed origins: <code className="text-white">{row.allowed_origins.length === 0 ? 'any' : row.allowed_origins.join(', ')}</code></div>
          <div>Rate limit: {row.rate_limit_per_ip_per_hour} sessions per IP per hour</div>
          <div>Max session: {row.max_session_minutes} minutes</div>
        </div>

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
