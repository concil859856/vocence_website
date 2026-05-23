/**
 * Pods tab — list, deploy, stop/restart/update/drain/remove, view logs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Pause, Plus, RefreshCw, RotateCcw, Trash2, UploadCloud } from 'lucide-react';
import { opsApi } from '../../lib/ops/api';
import {
  DEFAULT_IMAGES,
  DEFAULT_PORTS,
  SERVICE_LABELS,
  type PodDeployRequest,
  type PodRow,
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

  const refresh = useCallback(async () => {
    try {
      const [pl, sl] = await Promise.all([opsApi.listPods(token), opsApi.listServers(token)]);
      setPods(pl.pods);
      setServers(sl.servers);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const serversReady = useMemo(() => servers.filter((s) => s.status === 'ready'), [servers]);

  const handleAction = async (
    action: 'stop' | 'restart' | 'update' | 'drain' | 'remove',
    pod: PodRow,
  ) => {
    if (action === 'remove' && !window.confirm(`Remove pod "${pod.name}"? Container stops + is deleted.`)) return;
    if (action === 'update' && !window.confirm(`Roll out the latest ${pod.image} on "${pod.name}"? Container restarts (~30-60s downtime).`)) return;
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
            ? 'No ready servers yet — add one in the Servers tab first.'
            : 'No pods deployed. Click Deploy to start a service.'}
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-[#A7B0B7] text-[11px] uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2.5">Pod</th>
                <th className="text-left px-4 py-2.5">Service</th>
                <th className="text-left px-4 py-2.5">Server : port</th>
                <th className="text-left px-4 py-2.5">Status</th>
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
            <select
              value={form.server_id}
              onChange={(e) => setForm({ ...form, server_id: Number(e.target.value) })}
              className="input"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Service">
              <select
                value={form.service}
                onChange={(e) => handleServiceChange(e.target.value as ServiceName)}
                className="input"
              >
                {(Object.keys(SERVICE_LABELS) as ServiceName[]).map((s) => (
                  <option key={s} value={s}>{SERVICE_LABELS[s]}</option>
                ))}
              </select>
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
            <select
              value={tail}
              onChange={(e) => setTail(Number(e.target.value))}
              className="bg-[#07080A] border border-white/15 rounded-lg px-2 py-1 text-xs text-white"
            >
              {[100, 200, 500, 1000, 2000].map((n) => (
                <option key={n} value={n}>last {n}</option>
              ))}
            </select>
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
