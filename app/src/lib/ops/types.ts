/**
 * Vocence ops fleet-manager — shared types.
 * Mirrors dashboard-backend/ops/db.py + routers/ops.py response shapes.
 */

export type ServiceName =
  | 'tts_streaming'
  | 'voice_design'
  | 'music'
  | 'voice_clone'
  | 'stt'
  | 'noise_remover'
  // New voice-agent-pipeline pods (see VOICE_AGENT_PLATFORM_SPEC.md):
  | 'asr_streaming_rt'      // Parakeet TDT streaming STT (built by 4090 agent)
  | 'turn_detection'        // Smart Turn v3 + LiveKit Turn Detector v2 ensemble
  | 'knowledge_ingestion';  // Per-agent RAG: PDF/URL/text → BGE embeddings → LanceDB

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
  noise_remover: 'Noise Remover',
  asr_streaming_rt: 'Streaming STT',
  turn_detection: 'Turn Detection',
  knowledge_ingestion: 'Knowledge',
};

/** Default Docker Hub images per service. Admin can override at deploy time.
 * Namespace is `vocence` (the Docker Hub org), NOT `concil859856` (which is
 * the GitHub handle). Image names match each repo's release-workflow
 * IMAGE_NAME, so e.g. `voice_clone` (underscore) and `text-to-music`/
 * `asr-streaming` are the actual published names. */
export const DEFAULT_IMAGES: Record<ServiceName, string> = {
  tts_streaming: 'vocence/fast-tts-streaming:latest',
  voice_design: 'vocence/voice-design-non-streaming:latest',
  voice_clone: 'vocence/voice_clone:latest',
  stt: 'vocence/asr-streaming:latest',
  music: 'vocence/text-to-music:latest',
  noise_remover: 'vocence/voice-dubbing:latest',
  asr_streaming_rt: 'vocence/asr-streaming-rt:latest',
  turn_detection: 'vocence/turn-detection:latest',
  knowledge_ingestion: 'vocence/knowledge-ingestion:latest',
};

/** Default host port per service (matches container EXPOSE in each repo's Dockerfile). */
export const DEFAULT_PORTS: Record<ServiceName, number> = {
  tts_streaming: 8111,
  voice_design: 8112,
  voice_clone: 8113,
  stt: 8114,
  music: 8115,
  noise_remover: 8116,
  // asr_streaming_rt reuses 8114 — same logical "STT service" port.
  // It and ``stt`` never co-locate on one host (different image tags),
  // so the port number can be shared at the pod level.
  asr_streaming_rt: 8114,
  turn_detection: 8117,
  knowledge_ingestion: 8118,
};


// ---------------------------------------------------------------------------
// Pod / server runtime % + fleet health (Phase 1B)
// ---------------------------------------------------------------------------

export type RuntimeWindow = 'day' | 'week' | 'month';

export interface PodRuntimeRow {
  pod_id: number;
  name: string;
  service: ServiceName;
  server_id: number;
  status: PodStatus;
  online_seconds: number;
  window_seconds: number;
  uptime_pct: number;          // 0..100
}

export interface ServerRuntimeRow {
  server_id: number;
  name: string;
  host: string;
  status: ServerStatus;
  online_seconds: number;
  window_seconds: number;
  uptime_pct: number;
}

export interface PodHealthRow {
  pod_id: number;
  name: string;
  service: ServiceName;
  server_id: number;
  status: PodStatus;
  uptime_pct: number;
  success_rate: number;        // 0..1
  p95_latency_ms: number | null;
  /** Per-service p95 target this pod was scored against. Different
   *  services (streaming TTS vs music) have very different reasonable
   *  targets, so this varies per row. */
  p95_target_ms: number;
  latency_efficiency: number;  // 0..1
  score: number;               // 0..100
}

export interface FleetHealth {
  window: RuntimeWindow;
  /** Default p95 target — used only when a service isn't in the map.
   *  Per-pod targets are in ``pods[i].p95_target_ms``. */
  p95_target_ms: number;
  /** Per-service target map so the UI can surface, e.g.,
   *  "TTS target: 1000 ms · Music target: 180000 ms" if it wants. */
  p95_targets_by_service: Record<string, number>;
  network_mean_score: number | null;
  active_pod_count: number;
  pods: PodHealthRow[];
}


// ---------------------------------------------------------------------------
// LLM telemetry (Phase 1B)
// ---------------------------------------------------------------------------

export type LlmTimeRange = '1h' | '24h' | '7d' | '30d';
export type LlmTimeBucket = '1h' | '1d';
export type LlmProvider = 'cerebras' | 'xai' | 'groq' | 'openai' | 'chutes' | 'local';

export interface LlmOverview {
  range: string;
  calls: number;
  ok: number;
  errors: number;
  empties: number;
  rate_limited: number;
  timed_out: number;
  fallback_calls: number;
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  avg_latency_ms: number | null;
  avg_ttft_ms: number | null;
  p95_latency_ms: number | null;
}

export interface LlmBreakdownRow {
  provider?: string;
  model?: string;
  calls: number;
  ok: number;
  errors: number;
  rate_limited: number;
  timed_out: number;
  fallback_calls: number;
  cost_usd: number;
  total_tokens: number;
  avg_latency_ms: number | null;
  avg_ttft_ms: number | null;
}

export interface LlmFailureRow {
  id: string;
  provider: string;
  model: string;
  mode: 'chat' | 'stream';
  status: 'error' | 'empty';
  http_status: number | null;
  rate_limited: 0 | 1;
  timed_out: 0 | 1;
  latency_ms: number | null;
  ttft_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  fallback_from: string | null;
  fallback_reason: string | null;
  error_message: string | null;
  created_at: string;
}

export interface LlmTopError {
  err_prefix: string;
  count: number;
  provider: string;
  model: string;
}

export interface LlmFallbackRow {
  from_provider: string;
  to_provider: string;
  reason: string | null;
  hops: number;
  recovered: number;
  recovery_rate: number | null;
  cost_usd: number;
}

export interface LlmTimeseriesPoint {
  bucket: string;        // ISO-ish, hour or day
  calls: number;
  errors: number;
  rate_limited: number;
  timed_out: number;
  cost_usd: number;
  avg_latency_ms: number | null;
  avg_ttft_ms: number | null;
}

export interface LlmPricingRow {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  notes: string | null;
  active: 0 | 1;
  updated_at: string;
}
