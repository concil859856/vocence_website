/**
 * Pods tab, list, deploy, stop/restart/update/drain/remove, view logs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Pause, Plus, RefreshCw, RotateCcw, Trash2, UploadCloud } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';
import { Select as DropdownSelect } from '../ui/DropdownSelect';
import { opsApi } from '../../lib/ops/api';
import {
  DEFAULT_IMAGES,
  DEFAULT_PORTS,
  SERVICE_LABELS,
  type PodDeployRequest,
  type PodRow,
  type PodRuntimeRow,
  type RuntimeWindow,
  type ServerRow,
  type ServiceName,
} from '../../lib/ops/types';

interface Props { token: string }

export function PodsTab({ token }: Props) {
  const [pods, setPods] = useState<PodRow[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [logsPodId, setLogsPodId] = useState<number | null>(null);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);
  // Runtime % column: indexed by pod_id for O(1) row lookup.
  const [runtimeWindow, setRuntimeWindow] = useState<RuntimeWindow>('week');
  const [runtime, setRuntime] = useState<Record<number, PodRuntimeRow>>({});

  const refresh = useCallback(async () => {
    try {
      const [pl, sl, rt] = await Promise.all([
        opsApi.listPods(token),
        opsApi.listServers(token),
        opsApi.podsRuntime(token, runtimeWindow),
      ]);
      setPods(pl.pods);
      setServers(sl.servers);
      const idx: Record<number, PodRuntimeRow> = {};
      for (const r of rt.pods) idx[r.pod_id] = r;
      setRuntime(idx);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, runtimeWindow]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const serversReady = useMemo(() => servers.filter((s) => s.status === 'ready'), [servers]);

  const { confirm, dialog: confirmDialog } = useConfirm();

  const handleAction = async (
    action: 'stop' | 'restart' | 'update' | 'drain' | 'remove',
    pod: PodRow,
  ) => {
    if (action === 'remove') {
      if (!await confirm({ title: 'Remove Pod', message: `Remove pod "${pod.name}"? Container stops and is deleted.`, confirmLabel: 'Remove', confirmVariant: 'danger' })) return;
    }
    if (action === 'update') {
      if (!await confirm({ title: 'Update Pod', message: `Roll out the latest ${pod.image} on "${pod.name}"? Container restarts (~30-60s downtime).`, confirmLabel: 'Update', confirmVariant: 'primary' })) return;
    }
    setActionBusyId(pod.id);
    setError(null);
    try {
      if (action === 'stop') await opsApi.stopPod(token, pod.id);
      else if (action === 'restart') await opsApi.restartPod(token, pod.id);
      else if (action === 'update') await opsApi.updatePod(token, pod.id);
      else if (action === 'drain') await opsApi.drainPod(token, pod.id);
      else if (action === 'remove') await opsApi.removePod(token, pod.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-[#A7B0B7]">
          Running service containers across your registered servers.
        </p>
        <button
          type="button"
          onClick={() => setShowDeploy(true)}
          disabled={serversReady.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
          title={serversReady.length === 0 ? 'Add a ready server first' : undefined}
        >
          <Plus size={14} /> Deploy
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[#A7B0B7]">Loading…</p>
      ) : pods.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center text-sm text-[#A7B0B7]">
          {serversReady.length === 0
            ? 'No ready servers yet, add one in the Servers tab first.'
            : 'No pods deployed. Click Deploy to start a service.'}
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-white/[0.015] border-b border-white/5">
            <div className="text-[10px] uppercase tracking-wider text-[#A7B0B7]">Runtime window</div>
            <div className="inline-flex rounded-md border border-white/10 bg-white/[0.02] p-0.5">
              {(['day', 'week', 'month'] as RuntimeWindow[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setRuntimeWindow(w)}
                  className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                    runtimeWindow === w
                      ? 'bg-white/10 text-white'
                      : 'text-[#A7B0B7] hover:text-white'
                  }`}
                >
                  {w === 'day' ? '24h' : w === 'week' ? '7d' : '30d'}
                </button>
              ))}
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-[#A7B0B7] text-[11px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2.5">Pod</th>
                <th className="text-left px-4 py-2.5">Service</th>
                <th className="text-left px-4 py-2.5">Server : port</th>
                <th className="text-left px-4 py-2.5">Status</th>
                <th className="text-left px-4 py-2.5">Runtime %</th>
                <th className="text-left px-4 py-2.5">In-flight</th>
                <th className="text-left px-4 py-2.5">Image</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {pods.map((p) => {
                const server = servers.find((s) => s.id === p.server_id);
                const busy = actionBusyId === p.id;
                return (
                  <tr key={p.id} className="hover:bg-white/[0.015]">
                    <td className="px-4 py-3">
                      <div className="font-medium text-white">{p.name}</div>
                      <div className="text-[10px] text-[#666] font-mono">{(p.container_id ?? '').slice(0, 12)}</div>
                    </td>
                    <td className="px-4 py-3 text-white">{SERVICE_LABELS[p.service]}</td>
                    <td className="px-4 py-3 text-[#A7B0B7] font-mono text-xs">
                      {server?.host ?? '—'}:{p.port}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} consecutiveFailures={p.consecutive_failures} />
                    </td>
                    <td className="px-4 py-3">
                      <RuntimeCell row={runtime[p.id]} />
                    </td>
                    <td className="px-4 py-3 text-[#A7B0B7]">{p.dispatcher_in_flight}</td>
                    <td className="px-4 py-3">
                      <div className="text-[11px] text-[#A7B0B7] font-mono break-all">{p.image}</div>
                      {p.image_digest && (
                        <div className="text-[10px] text-[#666] font-mono">
                          {p.image_digest.replace(/^sha256:/, '').slice(0, 12)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <PodActionButton title="Logs" onClick={() => setLogsPodId(p.id)} disabled={busy}>
                          <FileText size={13} />
                        </PodActionButton>
                        <PodActionButton title="Restart" onClick={() => handleAction('restart', p)} disabled={busy}>
                          <RefreshCw size={13} />
                        </PodActionButton>
                        <PodActionButton title="Update (pull latest + restart)" onClick={() => handleAction('update', p)} disabled={busy}>
                          <UploadCloud size={13} />
                        </PodActionButton>
                        <PodActionButton title="Drain (no new traffic)" onClick={() => handleAction('drain', p)} disabled={busy || p.drain_requested === 1}>
                          <Pause size={13} />
                        </PodActionButton>
                        <PodActionButton title="Stop" onClick={() => handleAction('stop', p)} disabled={busy}>
                          <RotateCcw size={13} />
                        </PodActionButton>
                        <PodActionButton title="Remove" onClick={() => handleAction('remove', p)} disabled={busy} danger>
                          <Trash2 size={13} />
                        </PodActionButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showDeploy && (
        <DeployPodModal
          token={token}
          servers={serversReady}
          onClose={() => setShowDeploy(false)}
          onDeployed={() => { setShowDeploy(false); refresh(); }}
        />
      )}

      {logsPodId !== null && (
        <LogsModal token={token} podId={logsPodId} onClose={() => setLogsPodId(null)} />
      )}
      {confirmDialog}
    </div>
  );
}


function PodActionButton({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded transition-colors disabled:opacity-30 ${
        danger
          ? 'text-red-300 hover:text-red-200 hover:bg-red-500/[0.10]'
          : 'text-[#A7B0B7] hover:text-white hover:bg-white/[0.06]'
      }`}
    >
      {children}
    </button>
  );
}


function StatusBadge({ status, consecutiveFailures }: { status: string; consecutiveFailures: number }) {
  const color =
    status === 'online' ? 'text-[#DFFF00] bg-[#DFFF00]/10' :
    status === 'unhealthy' ? 'text-red-200 bg-red-500/15' :
    status === 'restarting' ? 'text-amber-200 bg-amber-500/15' :
    status === 'deploying' ? 'text-blue-200 bg-blue-500/15' :
    status === 'draining' ? 'text-orange-200 bg-orange-500/15' :
    'text-[#A7B0B7] bg-white/5';
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium px-2 py-0.5 rounded ${color}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {status}
      </span>
      {consecutiveFailures > 0 && (
        <span className="text-[10px] text-amber-300">
          {consecutiveFailures} fail{consecutiveFailures === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Deploy modal
// ---------------------------------------------------------------------------

function DeployPodModal({
  token,
  servers,
  onClose,
  onDeployed,
}: {
  token: string;
  servers: ServerRow[];
  onClose: () => void;
  onDeployed: () => void;
}) {
  const [form, setForm] = useState<PodDeployRequest>({
    server_id: servers[0]?.id ?? 0,
    name: '',
    service: 'tts_streaming',
    image: DEFAULT_IMAGES.tts_streaming,
    port: DEFAULT_PORTS.tts_streaming,
    api_key: '',
    extra_env: {},
    gpu_index: null,
  });
  const [extraEnvText, setExtraEnvText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-fill image + port when service changes.
  const handleServiceChange = (svc: ServiceName) => {
    setForm((f) => ({
      ...f,
      service: svc,
      image: DEFAULT_IMAGES[svc],
      port: DEFAULT_PORTS[svc],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Parse extra env: one KEY=VALUE per line.
    const extra_env: Record<string, string> = {};
    for (const line of extraEnvText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) {
        setError(`malformed env line: ${trimmed}`);
        return;
      }
      extra_env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }

    setSubmitting(true);
    try {
      await opsApi.deployPod(token, {
        ...form,
        extra_env,
        api_key: form.api_key?.trim() || null,
      });
      onDeployed();
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
          <h3 className="text-xl text-white font-semibold">Deploy service</h3>
          <p className="text-xs text-[#A7B0B7]">
            Pulls the image on the selected server and starts a container.
            Health-poller flips status to "online" once the container's
            /healthz responds (~30-60s for cold model load).
          </p>

          <Field label="Server">
            <DropdownSelect
              value={String(form.server_id)}
              onChange={(v) => setForm({ ...form, server_id: Number(v) })}
              options={servers.map((s) => ({ value: String(s.id), label: `${s.name} (${s.host})` }))}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Service">
              <DropdownSelect
                value={form.service}
                onChange={(v) => handleServiceChange(v as ServiceName)}
                options={(Object.keys(SERVICE_LABELS) as ServiceName[]).map((s) => ({ value: s, label: SERVICE_LABELS[s] }))}
              />
            </Field>
            <Field label="Pod name" hint="lowercase, digits, dashes">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]"
                placeholder="tts-prod-1"
                className="input"
              />
            </Field>
          </div>

          <Field label="Image" hint="Docker Hub tag, e.g. vocence/fast-tts-streaming:latest">
            <input
              value={form.image}
              onChange={(e) => setForm({ ...form, image: e.target.value })}
              required
              placeholder="vocence/fast-tts-streaming:latest"
              className="input font-mono text-[12px]"
            />
          </Field>

          <Field label="Host port">
            <input
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              min={1024}
              max={65535}
              required
              className="input"
            />
          </Field>

          <GpuPicker
            server={servers.find((s) => s.id === form.server_id)}
            value={form.gpu_index ?? null}
            onChange={(v) => setForm({ ...form, gpu_index: v })}
            onProbe={async () => {
              try {
                await opsApi.reprobeServer(token, form.server_id);
                // Probe is async server-side (~20-30s for SSH +
                // nvidia-smi). Caller polls servers via PodsTab's
                // own refresh tick; surfacing onDeployed() here is
                // overkill, just toast.
                setError('GPU probe queued — refresh in a moment.');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />

          <Field
            label="API key (bearer)"
            hint="Leave blank to auto-generate. Stored encrypted at rest."
          >
            <input
              value={form.api_key ?? ''}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
              placeholder="(auto-generate)"
              className="input font-mono text-[12px]"
            />
          </Field>

          <Field
            label="Extra env (one KEY=VALUE per line)"
            hint="Only valid env keys: [A-Z_][A-Z0-9_]+. Comments (#) ignored."
          >
            <textarea
              value={extraEnvText}
              onChange={(e) => setExtraEnvText(e.target.value)}
              rows={4}
              placeholder={'QWEN3_TTS_CAP=4\nQWEN3_TTS_CHUNK_SIZE=8'}
              className="input font-mono text-[12px]"
            />
          </Field>

          {error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="text-sm text-[#A7B0B7] hover:text-white px-4 py-2">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
            >
              {submitting ? 'Deploying…' : 'Deploy'}
            </button>
          </div>
        </form>

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


// ---------------------------------------------------------------------------
// Logs modal
// ---------------------------------------------------------------------------

/** GPU picker for the deploy modal. Renders one option per physical
 *  GPU detected by the server's nvidia-smi probe, plus an "all GPUs"
 *  default for single-GPU hosts. Shows which GPUs are already taken
 *  by other pods on the same server so the admin doesn't accidentally
 *  pile two pods on the same card.
 *
 *  When the server has no probed gpu_info (just-added, or probe
 *  failed), shows a "no GPU info yet — probe?" prompt with a refresh
 *  button. Picker is disabled in that state. */
function GpuPicker({
  server,
  value,
  onChange,
  onProbe,
}: {
  server: ServerRow | undefined;
  value: number | null;
  onChange: (v: number | null) => void;
  onProbe: () => Promise<void>;
}) {
  const [probing, setProbing] = useState(false);

  if (!server) {
    return null;
  }

  const gpus = server.gpus || [];

  // Map gpu_index → array of pod names already running on it, for the
  // collision hint. Pods with gpu_index=NULL ("--gpus all") are listed
  // separately because they conflict with EVERYTHING.
  const usage = new Map<number, string[]>();
  const podsOnAll: string[] = [];
  for (const p of server.pods_summary || []) {
    if (p.status === 'removed' || p.status === 'stopped') continue;
    if (p.gpu_index == null) {
      podsOnAll.push(p.name);
    } else {
      const arr = usage.get(p.gpu_index) || [];
      arr.push(p.name);
      usage.set(p.gpu_index, arr);
    }
  }

  const handleProbe = async () => {
    setProbing(true);
    try {
      await onProbe();
    } finally {
      setProbing(false);
    }
  };

  return (
    <Field
      label="GPU"
      hint={
        gpus.length === 0
          ? 'Server hasn\'t been probed yet — click Probe to detect GPUs.'
          : `Pin this pod to one of the ${gpus.length} GPU(s) on ${server.name}. Required when multiple pods share the same server.`
      }
    >
      <div className="space-y-2">
        {gpus.length === 0 ? (
          <button
            type="button"
            onClick={handleProbe}
            disabled={probing}
            className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-white hover:bg-white/[0.08] disabled:opacity-50"
          >
            {probing ? 'Probing...' : 'Probe GPUs'}
          </button>
        ) : (
          <>
            <div className="flex gap-2">
              <select
                value={value === null ? '' : String(value)}
                onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
                className="input flex-1"
              >
                <option value="">All GPUs (single-pod hosts only)</option>
                {gpus.map((g) => {
                  const taken = usage.get(g.index) || [];
                  const memGB = g.memory_total_mib ? Math.round(g.memory_total_mib / 1024) : null;
                  const label =
                    `GPU ${g.index} — ${g.name}` +
                    (memGB ? ` (${memGB} GB)` : '') +
                    (taken.length ? ` — taken by ${taken.join(', ')}` : ' — free');
                  return (
                    <option key={g.index} value={g.index}>
                      {label}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                onClick={handleProbe}
                disabled={probing}
                title="Re-probe nvidia-smi on the server"
                className="rounded-lg border border-white/15 bg-white/[0.04] px-3 text-sm text-[#A7B0B7] hover:text-white hover:bg-white/[0.08] disabled:opacity-50"
              >
                {probing ? '...' : '↻'}
              </button>
            </div>
            {podsOnAll.length > 0 && (
              <p className="text-xs text-yellow-300/90">
                Warning: {podsOnAll.length} pod{podsOnAll.length === 1 ? '' : 's'}{' '}
                ({podsOnAll.join(', ')}) on this server use --gpus all and will
                contend with whichever GPU you pick.
              </p>
            )}
            {value != null && (usage.get(value) || []).length > 0 && (
              <p className="text-xs text-yellow-300/90">
                Warning: GPU {value} is already in use by{' '}
                {(usage.get(value) || []).join(', ')}. Two pods on the same
                GPU will fight for VRAM.
              </p>
            )}
          </>
        )}
      </div>
    </Field>
  );
}

// ---------------------------------------------------------------------------

function LogsModal({ token, podId, onClose }: { token: string; podId: number; onClose: () => void }) {
  const [logs, setLogs] = useState<string>('');
  const [tail, setTail] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await opsApi.podLogs(token, podId, tail);
      setLogs(r.logs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, podId, tail]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d0e10] border border-white/15 rounded-2xl max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h3 className="text-white font-semibold">Logs · pod {podId}</h3>
          <div className="flex items-center gap-2">
            <DropdownSelect
              value={String(tail)}
              onChange={(v) => setTail(Number(v))}
              options={[100, 200, 500, 1000, 2000].map((n) => ({ value: String(n), label: `last ${n}` }))}
              className="w-28"
            />
            <button type="button" onClick={load} className="text-xs text-[#A7B0B7] hover:text-white px-2">
              Refresh
            </button>
            <button type="button" onClick={onClose} className="text-sm text-[#A7B0B7] hover:text-white px-2">
              Close
            </button>
          </div>
        </div>
        {error && (
          <div className="px-4 py-2 text-sm text-red-200 bg-red-500/[0.06] border-b border-red-400/30">{error}</div>
        )}
        <pre className="flex-1 overflow-auto text-[11px] text-[#cbd5e1] bg-[#04050a] p-4 font-mono whitespace-pre-wrap">
          {loading && logs === '' ? 'Loading…' : logs || '(no logs)'}
        </pre>
      </div>
    </div>
  );
}


/** Per-row uptime % + a thin progress bar. Colour matches the same
 *  thresholds as the FleetHealthCard score bar so the operator's eye
 *  trains across the page. */
function RuntimeCell({ row }: { row?: PodRuntimeRow }) {
  if (!row) return <span className="text-[10px] text-[#666]">—</span>;
  const pct = row.uptime_pct;
  const color = pct >= 99 ? 'bg-[#DFFF00]' : pct >= 90 ? 'bg-amber-300' : 'bg-red-400';
  const textColor = pct >= 99 ? 'text-[#DFFF00]' : pct >= 90 ? 'text-amber-200' : 'text-red-300';
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="w-16 h-1.5 rounded-full bg-white/5 overflow-hidden shrink-0">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className={`text-xs tabular-nums ${textColor}`}>{pct.toFixed(1)}%</span>
    </div>
  );
}
