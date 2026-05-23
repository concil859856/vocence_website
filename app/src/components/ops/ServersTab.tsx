/**
 * Servers tab — list rented GPU boxes, add new ones, re-probe, remove.
 * The "Add Server" form runs probe_server synchronously so the admin
 * immediately sees whether SSH + Docker + nvidia-smi all came back ok.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Cpu, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { opsApi } from '../../lib/ops/api';
import type { ServerAddRequest, ServerRow } from '../../lib/ops/types';

interface Props { token: string }

export function ServersTab({ token }: Props) {
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await opsApi.listServers(token);
      setServers(r.servers);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const handleReprobe = async (id: number) => {
    setActionBusyId(id);
    try {
      await opsApi.reprobeServer(token, id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionBusyId(null);
    }
  };

  const handleRemove = async (id: number, name: string) => {
    if (!window.confirm(`Remove server "${name}"? Its pods will be tombstoned (containers keep running until you SSH in and stop them).`)) return;
    setActionBusyId(id);
    try {
      await opsApi.removeServer(token, id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[#A7B0B7]">
          Rented GPU boxes the platform can deploy services to.
        </p>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110"
        >
          <Plus size={14} /> Add server
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[#A7B0B7]">Loading…</p>
      ) : servers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center text-sm text-[#A7B0B7]">
          No servers registered yet. Click <span className="text-[#DFFF00]">+ Add server</span> to register your first rented 4090.
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((s) => <ServerRowCard key={s.id} server={s} busy={actionBusyId === s.id} onReprobe={() => handleReprobe(s.id)} onRemove={() => handleRemove(s.id, s.name)} />)}
        </div>
      )}

      {showAdd && (
        <AddServerModal
          token={token}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); refresh(); }}
        />
      )}
    </div>
  );
}


function ServerRowCard({
  server,
  busy,
  onReprobe,
  onRemove,
}: {
  server: ServerRow;
  busy: boolean;
  onReprobe: () => void;
  onRemove: () => void;
}) {
  const gpus = parseGpuInfo(server.gpu_info_json);
  const statusColor =
    server.status === 'ready' ? 'text-[#DFFF00]' :
    server.status === 'unreachable' ? 'text-red-300' :
    'text-amber-300';
  const StatusIcon = server.status === 'ready' ? CheckCircle2 : XCircle;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white font-semibold">{server.name}</span>
            <span className={`inline-flex items-center gap-1 text-xs ${statusColor}`}>
              <StatusIcon size={13} /> {server.status}
            </span>
          </div>
          <div className="text-xs text-[#A7B0B7] font-mono">
            {server.ssh_user}@{server.host}:{server.ssh_port}
          </div>
          {server.docker_version && (
            <div className="text-[11px] text-[#666] mt-1">{server.docker_version}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReprobe}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs text-[#A7B0B7] hover:text-white bg-white/[0.04] hover:bg-white/[0.08] px-3 py-1.5 rounded-lg disabled:opacity-40"
          >
            <RefreshCw size={13} /> Probe
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-red-200 bg-red-500/[0.06] hover:bg-red-500/[0.10] px-3 py-1.5 rounded-lg disabled:opacity-40"
          >
            <Trash2 size={13} /> Remove
          </button>
        </div>
      </div>

      {gpus.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {gpus.map((g) => (
            <div key={g.index} className="rounded-lg border border-white/5 bg-[#07080A]/60 px-3 py-2 text-xs">
              <div className="flex items-center gap-2 text-white">
                <Cpu size={12} className="text-[#DFFF00]" /> GPU {g.index}: {g.name}
              </div>
              <div className="text-[#A7B0B7] mt-0.5">
                {g.memory_used_mib ?? '?'} / {g.memory_total_mib ?? '?'} MiB · driver {g.driver_version}
              </div>
            </div>
          ))}
        </div>
      )}

      {server.pods_summary.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {server.pods_summary.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5 text-[11px] bg-white/[0.04] px-2 py-1 rounded-md text-[#A7B0B7]">
              <span className="text-white">{p.name}</span>
              <span>·</span>
              <span>{p.service}</span>
              <span>·</span>
              <span className={statusDotColor(p.status)}>{p.status}</span>
            </span>
          ))}
        </div>
      )}

      {server.notes && (
        <p className="mt-3 text-xs text-[#A7B0B7] italic">{server.notes}</p>
      )}
    </div>
  );
}


function statusDotColor(s: string): string {
  return s === 'online' ? 'text-[#DFFF00]' :
         s === 'unhealthy' ? 'text-red-300' :
         s === 'restarting' || s === 'deploying' || s === 'draining' ? 'text-amber-300' :
         'text-[#666]';
}


interface GpuRow {
  index: number;
  name: string;
  memory_total_mib: number | null;
  memory_used_mib: number | null;
  driver_version: string;
}

function parseGpuInfo(raw: string | null): GpuRow[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr as GpuRow[];
  } catch {
    return [];
  }
}


// ---------------------------------------------------------------------------
// Add Server modal
// ---------------------------------------------------------------------------

function AddServerModal({ token, onClose, onAdded }: { token: string; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState<ServerAddRequest>({
    name: '',
    host: '',
    ssh_user: 'root',
    ssh_port: 22,
    ssh_private_key: null,
    hourly_cost_usd: 0,
    notes: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setProbeError(null);
    try {
      const r = await opsApi.addServer(token, {
        ...form,
        ssh_private_key: form.ssh_private_key?.trim() || null,
        notes: form.notes?.trim() || null,
      });
      if (r.probe_error) {
        // Server row was created but SSH probe failed — leave the modal open
        // so the admin can fix and retry.
        setProbeError(r.probe_error);
      } else {
        onAdded();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d0e10] border border-white/15 rounded-2xl max-w-xl w-full max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h3 className="text-xl text-white font-semibold">Add server</h3>
          <p className="text-xs text-[#A7B0B7]">
            On the rented box, first SSH in and add the platform public key to
            <code className="bg-white/5 px-1 mx-1 rounded">~/.ssh/authorized_keys</code>,
            then install Docker + nvidia-container-toolkit. After that, fill this form
            and the platform will probe and start managing it.
          </p>

          <Field label="Display name" hint="lowercase, digits, dashes; 2-64 chars">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]"
              placeholder="shadecloud-1"
              className="input"
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Host" hint="IP or DNS">
                <input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  required
                  placeholder="10.0.0.42"
                  className="input"
                />
              </Field>
            </div>
            <Field label="SSH port">
              <input
                type="number"
                value={form.ssh_port}
                onChange={(e) => setForm({ ...form, ssh_port: Number(e.target.value) || 22 })}
                min={1}
                max={65535}
                className="input"
              />
            </Field>
          </div>
          <Field label="SSH user">
            <input
              value={form.ssh_user}
              onChange={(e) => setForm({ ...form, ssh_user: e.target.value })}
              placeholder="root"
              className="input"
            />
          </Field>
          <Field
            label="SSH private key (optional)"
            hint="Leave blank to use the platform-wide key at OPS_SSH_PRIVATE_KEY_PATH on the backend."
          >
            <textarea
              value={form.ssh_private_key ?? ''}
              onChange={(e) => setForm({ ...form, ssh_private_key: e.target.value })}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
              rows={4}
              className="input font-mono text-[11px]"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hourly cost ($)" hint="Optional, for analytics">
              <input
                type="number"
                step="0.01"
                value={form.hourly_cost_usd}
                onChange={(e) => setForm({ ...form, hourly_cost_usd: Number(e.target.value) || 0 })}
                className="input"
              />
            </Field>
            <Field label="Notes (optional)">
              <input
                value={form.notes ?? ''}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="shadecloud, RTX 4090, rented 2026-05-22"
                className="input"
              />
            </Field>
          </div>

          {error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
              {error}
            </div>
          )}
          {probeError && (
            <div className="rounded-lg border border-amber-400/30 bg-amber-500/[0.06] text-amber-200 text-sm px-3 py-2">
              Server row was added but the SSH/Docker probe failed: {probeError}.
              Fix and click "Probe" on the server row to retry.
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-[#A7B0B7] hover:text-white px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? 'Probing…' : probeError ? 'Done — close' : 'Add + probe'}
            </button>
          </div>
        </form>
      </div>

      {/* Local input styles so we don't pollute global CSS. */}
      <style>{`
        .input {
          width: 100%;
          background: #07080A;
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 13px;
          color: white;
          outline: none;
        }
        .input:focus { border-color: rgba(223,255,0,0.4); }
        .input::placeholder { color: #666; }
      `}</style>
    </div>
  );
}


function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-[#666] mt-1">{hint}</div>}
    </label>
  );
}
