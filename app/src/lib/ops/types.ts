/**
 * Vocence ops fleet-manager — shared types.
 * Mirrors dashboard-backend/ops/db.py + routers/ops.py response shapes.
 */

export type ServiceName =
  | 'tts_streaming'
  | 'voice_design'
  | 'music'
  | 'voice_clone'
  | 'stt';

export type ServerStatus = 'pending' | 'ready' | 'unreachable' | 'removed';

export type PodStatus =
  | 'deploying'
  | 'online'
  | 'unhealthy'
  | 'restarting'
  | 'draining'
  | 'stopped'
  | 'removed';

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  ssh_user: string;
  ssh_port: number;
  hourly_cost_usd: number;
  status: ServerStatus;
  last_seen_at: string | null;
  docker_version: string | null;
  gpu_info_json: string | null;          // JSON-encoded list<{index,name,memory_total_mib,...}>
  notes: string | null;
  created_at: string;
  updated_at: string;
  pod_count: number;
  pods_summary: { id: number; name: string; service: ServiceName; port: number; status: PodStatus }[];
}

export interface PodRow {
  id: number;
  server_id: number;
  name: string;
  service: ServiceName;
  image: string;
  image_digest: string | null;
  container_id: string | null;
  port: number;
  status: PodStatus;
  consecutive_failures: number;
  drain_requested: number;
  last_healthz_at: string | null;
  last_healthz_json: string | null;
  last_metrics_at: string | null;
  last_metrics_json: string | null;
  deployed_at: string;
  updated_at: string;
  /** Live dispatcher in-flight count (NOT the same as the pod's own /healthz inflight). */
  dispatcher_in_flight: number;
}

export interface OverviewTiles {
  servers_total: number;
  servers_ready: number;
  pods_total: number;
  pods_by_status: Partial<Record<PodStatus, number>>;
  pods_by_service: Partial<Record<ServiceName, number>>;
  dispatcher_inflight: number;
  dispatcher_capacity_2N: number;
}

export interface DispatcherServiceState {
  n_pods: number;
  total_in_flight: number;
  global_cap: number;
  pods: {
    id: number;
    name: string;
    host: string;
    port: number;
    status: PodStatus;
    drain_requested: boolean;
    in_flight: number;
    pod_cap: number;
  }[];
}

export type DispatcherSnapshot = Record<ServiceName, DispatcherServiceState>;

export interface TimeseriesPoint {
  minute_ts: number;                      // unix epoch / 60
  requests_ok: number;
  requests_err: Record<string, number>;   // by error code
  duration_ms_sum: number;
  duration_ms_count: number;
  duration_ms_p95: number;
  max_inflight: number;
  bytes_sent: number;
  audio_ms: number;
}

export interface PodEvent {
  id: number;
  pod_id: number | null;
  kind: string;       // 'deploy_started' | 'auto_restart' | 'update_available' | etc.
  message: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface ServerAddRequest {
  name: string;
  host: string;
  ssh_user?: string;
  ssh_port?: number;
  ssh_private_key?: string | null;
  hourly_cost_usd?: number;
  notes?: string | null;
}

export interface PodDeployRequest {
  server_id: number;
  name: string;
  service: ServiceName;
  image: string;
  port: number;
  api_key?: string | null;
  extra_env?: Record<string, string>;
}

export const SERVICE_LABELS: Record<ServiceName, string> = {
  tts_streaming: 'TTS Streaming',
  voice_design: 'Voice Design',
  music: 'Music',
  voice_clone: 'Voice Clone',
  stt: 'Speech-to-Text',
};

/** Default Docker Hub images per service. Admin can override at deploy time. */
export const DEFAULT_IMAGES: Record<ServiceName, string> = {
  tts_streaming: 'concil859856/fast-tts-streaming:latest',
  voice_design: 'concil859856/voice-design-non-streaming:latest',
  voice_clone: 'concil859856/voice-clone:latest',
  stt: 'concil859856/stt:latest',
  music: 'concil859856/music:latest',
};

/** Default host port per service (matches container EXPOSE in each repo's Dockerfile). */
export const DEFAULT_PORTS: Record<ServiceName, number> = {
  tts_streaming: 8111,
  voice_design: 8112,
  voice_clone: 8113,
  stt: 8114,
  music: 8115,
};
