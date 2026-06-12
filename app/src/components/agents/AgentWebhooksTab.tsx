/**
 * Webhooks tab on the agent detail page.
 *
 *   • List registered webhooks (URL + events + active flag).
 *   • Add a new webhook — secret shown ONCE in a modal so the user
 *     can copy it before it disappears.
 *   • Recent deliveries per webhook with status / HTTP code / error.
 *   • Test button enqueues a synthetic webhook.test event.
 *
 * The signing format is documented in vocence-sdk/python/src/vocence/
 * webhooks.py — server-side mirror lives in dashboard-backend/
 * webhooks_service.py. Both must agree on the header names + signed
 * string.
 */

import { useEffect, useState } from 'react';
import { Loader2, AlertCircle, Plus, Trash2, Send, Copy, X, Webhook } from 'lucide-react';
import { agentsApi } from '../../lib/agents/api';
import { useConfirm } from '../../hooks/useConfirm';
import type {
  AgentWebhook,
  AgentWebhookCreated,
  WebhookDelivery,
} from '../../lib/agents/types';

interface Props {
  agentId: string;
  token: string | null;
}

const STATUS_CHIP: Record<WebhookDelivery['status'], string> = {
  pending:    'bg-white/[0.06] text-white/60',
  delivering: 'bg-blue-500/15 text-blue-300',
  delivered:  'bg-emerald-500/15 text-emerald-300',
  failed:     'bg-red-500/15 text-red-300',
};

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  const min = Math.round(delta / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}

export function AgentWebhooksTab({ agentId, token }: Props) {
  const [webhooks, setWebhooks] = useState<AgentWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [creating, setCreating] = useState(false);
  // The just-created webhook including the plaintext secret. Cleared
  // when the user dismisses the modal — by design, we never let
  // them re-open it.
  const [secretModalFor, setSecretModalFor] = useState<AgentWebhookCreated | null>(null);
  // Webhook whose deliveries panel is currently expanded.
  const [openDeliveriesFor, setOpenDeliveriesFor] = useState<string | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const refresh = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await agentsApi.listWebhooks(token, agentId);
      setWebhooks(res.webhooks);
    } catch (err) {
      setError((err as Error)?.message ?? 'failed to load webhooks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, token]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !newUrl.trim()) return;
    setCreating(true);
    try {
      const res = await agentsApi.createWebhook(token, agentId, { url: newUrl.trim() });
      setNewUrl('');
      setSecretModalFor(res.webhook);
      // Optimistic insert (without secret) so the list updates
      // immediately.
      const { secret: _omit, ...listShape } = res.webhook;
      setWebhooks((prev) => [listShape, ...prev]);
    } catch (err) {
      setError((err as Error)?.message ?? 'failed to create webhook');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (wh: AgentWebhook) => {
    if (!token) return;
    const ok = await confirm({
      title: 'Delete webhook?',
      message: `Stop sending events to ${wh.url}? Pending undelivered events for this webhook will also be dropped.`,
      confirmLabel: 'Delete webhook',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    try {
      await agentsApi.deleteWebhook(token, agentId, wh.id);
      setWebhooks((prev) => prev.filter((w) => w.id !== wh.id));
      if (openDeliveriesFor === wh.id) setOpenDeliveriesFor(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'failed to delete webhook');
    }
  };

  const handleTest = async (wh: AgentWebhook) => {
    if (!token) return;
    try {
      await agentsApi.testWebhook(token, agentId, wh.id);
      // Auto-expand deliveries so the user sees the test land.
      setOpenDeliveriesFor(wh.id);
    } catch (err) {
      setError((err as Error)?.message ?? 'failed to send test');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Webhooks</h2>
          <p className="text-xs text-white/40 mt-0.5">
            POST signed events (e.g. <code className="text-white/60">call.ended</code>) to a URL of your choice.
            Verify with the <code className="text-white/60">vocence</code> SDK's
            <code className="text-white/60 ml-1">webhooks.verify()</code> helper.
          </p>
        </div>
      </div>

      {/* New webhook form */}
      <form
        onSubmit={handleCreate}
        className="flex items-center gap-2 bg-white/[0.02] border border-white/10 rounded-xl px-3 py-2"
      >
        <input
          type="url"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="https://your-app.example.com/vocence/webhook"
          required
          className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!newUrl.trim() || creating}
          className="inline-flex items-center gap-1.5 bg-[#DFFF00] text-[#07080A] hover:brightness-110 disabled:opacity-50 px-3 py-1.5 rounded-md text-xs font-semibold"
        >
          {creating ? <Loader2 className="animate-spin" size={12} /> : <Plus size={12} />}
          Add
        </button>
      </form>

      {error && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-xl px-4 py-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">{error}</div>
          <button onClick={() => setError(null)} className="text-red-200/60 hover:text-white">
            <X size={14} />
          </button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12 text-white/40">
          <Loader2 className="animate-spin mr-2" size={16} /> Loading…
        </div>
      )}

      {!loading && webhooks.length === 0 && (
        <div className="text-center py-12 text-white/40">
          <Webhook size={28} className="mx-auto mb-3 opacity-40" />
          <div className="text-sm">No webhooks configured.</div>
          <div className="text-xs mt-1 opacity-60">
            Add a URL above to start receiving event POSTs.
          </div>
        </div>
      )}

      {!loading && webhooks.length > 0 && (
        <div className="space-y-3">
          {webhooks.map((wh) => (
            <div key={wh.id} className="bg-white/[0.02] border border-white/10 rounded-xl">
              <div className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate" title={wh.url}>{wh.url}</div>
                  <div className="text-[11px] text-white/40 mt-0.5">
                    {wh.events.includes('*') ? 'All events' : wh.events.join(', ')} •
                    <span className="ml-1">created {formatRelative(wh.created_at)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenDeliveriesFor(openDeliveriesFor === wh.id ? null : wh.id)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 hover:bg-white/10 hover:text-white"
                >
                  Deliveries
                </button>
                <button
                  type="button"
                  onClick={() => handleTest(wh)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 hover:bg-white/10 hover:text-white"
                  title="Send a synthetic webhook.test event"
                >
                  <Send size={12} /> Test
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(wh)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/50 hover:bg-red-500/10 hover:text-red-300"
                  title="Delete webhook"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {openDeliveriesFor === wh.id && (
                <DeliveriesPanel agentId={agentId} webhookId={wh.id} token={token} />
              )}
            </div>
          ))}
        </div>
      )}

      {secretModalFor && (
        <SecretModal
          webhook={secretModalFor}
          onClose={() => setSecretModalFor(null)}
        />
      )}
      {confirmDialog}
    </div>
  );
}

// ─── Deliveries panel ───────────────────────────────────────────────

interface DeliveriesPanelProps {
  agentId: string;
  webhookId: string;
  token: string | null;
}

function DeliveriesPanel({ agentId, webhookId, token }: DeliveriesPanelProps) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!token) return;
    try {
      const res = await agentsApi.listWebhookDeliveries(token, agentId, webhookId, 20);
      setDeliveries(res.deliveries);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'failed to load deliveries');
    }
  };

  useEffect(() => {
    void refresh();
    // Poll every 3 s while the panel is open so the user sees test
    // sends + retries land without a manual refresh.
    const t = window.setInterval(refresh, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, webhookId, token]);

  return (
    <div className="border-t border-white/10 px-4 py-3 bg-white/[0.015]">
      {error && (
        <div className="text-xs text-red-300 mb-2">{error}</div>
      )}
      {deliveries === null && !error && (
        <div className="flex items-center text-white/40 text-xs">
          <Loader2 className="animate-spin mr-2" size={12} /> Loading…
        </div>
      )}
      {deliveries && deliveries.length === 0 && (
        <div className="text-xs text-white/40">No deliveries yet. Hit Test to send one.</div>
      )}
      {deliveries && deliveries.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
              <th className="py-1.5 pr-4 font-medium">When</th>
              <th className="py-1.5 pr-4 font-medium">Event</th>
              <th className="py-1.5 pr-4 font-medium">Status</th>
              <th className="py-1.5 pr-4 font-medium">HTTP</th>
              <th className="py-1.5 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id} className="border-t border-white/5">
                <td className="py-1.5 pr-4 text-white/60" title={d.last_attempted_at ?? d.created_at}>
                  {formatRelative(d.last_attempted_at ?? d.created_at)}
                </td>
                <td className="py-1.5 pr-4 text-white/80">{d.event_type}</td>
                <td className="py-1.5 pr-4">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_CHIP[d.status]}`}>
                    {d.status}{d.attempt > 1 ? ` (#${d.attempt})` : ''}
                  </span>
                </td>
                <td className="py-1.5 pr-4 text-white/60">{d.last_status_code ?? '—'}</td>
                <td className="py-1.5 text-red-300/80 truncate max-w-[280px]" title={d.last_error ?? undefined}>
                  {d.last_error ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Secret modal (one-time display) ────────────────────────────────

function SecretModal({
  webhook,
  onClose,
}: {
  webhook: AgentWebhookCreated;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhook.secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can still select+copy by hand */
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#0E1014] border border-white/10 rounded-2xl max-w-lg w-full p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">Webhook secret</h3>
          <button onClick={onClose} className="p-1.5 rounded-md text-white/60 hover:bg-white/10 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <p className="text-xs text-white/60 leading-relaxed">
          Save this secret somewhere safe — it's used to verify every event we send to{' '}
          <code className="text-white/80">{webhook.url}</code>.
          For security, <strong className="text-amber-300">we will not show it again</strong>.
        </p>
        <div className="mt-3 flex items-stretch gap-2">
          <code className="flex-1 bg-[#07080A] border border-white/10 rounded-lg px-3 py-2 text-[11px] font-mono text-white/90 break-all">
            {webhook.secret}
          </code>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-2 bg-white/10 hover:bg-white/15 text-xs text-white rounded-md"
          >
            <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="mt-5 text-right">
          <button
            type="button"
            onClick={onClose}
            className="bg-[#DFFF00] text-[#07080A] hover:brightness-110 px-4 py-1.5 rounded-md text-xs font-semibold"
          >
            I've saved it
          </button>
        </div>
      </div>
    </div>
  );
}
