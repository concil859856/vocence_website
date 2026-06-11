/**
 * Dashboard API client, same backend as auth (VITE_API_URL).
 */
import { API_ORIGIN_BASE } from './baseUrl';
import { authFetch } from './authFetch';

const DASHBOARD_BASE = API_ORIGIN_BASE;

/**
 * Build the Authorization + X-Admin-Token headers for admin-only dashboard calls.
 *
 * Backend gates admin routes on TWO layers (see routers/admin_auth.py):
 *   1. `Authorization: Bearer <JWT>`, Google OAuth + email == ADMIN_EMAIL
 *   2. `X-Admin-Token: <admin_token>`, sudo-mode unlock (separate password)
 *
 * Both must be sent or the backend rejects with 401 code=admin_unlock_required,
 * which the AdminGate wrapper interprets by popping the AdminUnlockModal.
 *
 * The JWT lives in localStorage (survives browser close). The admin_token
 * lives in sessionStorage (cleared on browser close, by design; admin
 * should re-auth after closing their laptop).
 */
function adminAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof window === 'undefined') return headers;
  const token = window.localStorage.getItem('vocence_token') || '';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const adminToken = window.sessionStorage.getItem('vocence.admin_token') || '';
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  return headers;
}

/**
 * Error thrown by `fetchJson` for non-2xx responses (or network failures).
 * `userMessage` is sanitized for display to end users; `detail` carries the
 * raw server detail (or stack/text) for telemetry/console logging.
 */
export class ApiError extends Error {
  status: number;
  userMessage: string;
  detail: string;
  constructor(opts: { status: number; userMessage: string; detail: string }) {
    super(opts.userMessage);
    this.name = 'ApiError';
    this.status = opts.status;
    this.userMessage = opts.userMessage;
    this.detail = opts.detail;
  }
}

function _genericForStatus(status: number): string {
  if (status === 0) return "Couldn't reach the server. Check your connection and try again.";
  if (status === 401) return 'Please sign in and try again.';
  if (status === 403) return 'You don\'t have permission to do that.';
  if (status === 404) return 'That resource is no longer available.';
  if (status === 408) return 'The request took too long. Please try again.';
  if (status === 413) return 'That file is too large.';
  if (status === 415) return 'That file type isn\'t supported.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500 && status < 600) return 'Something went wrong on our side. Please try again.';
  return 'Something went wrong. Please try again.';
}

/** Pull a clean, user-safe message from a raw response body. */
function _extractUserMessage(status: number, text: string): { userMessage: string; detail: string } {
  const detail = (text || '').trim();
  // For server errors, never echo the raw detail (tracebacks, internal IDs).
  if (status >= 500 || status === 0) {
    return { userMessage: _genericForStatus(status), detail };
  }
  // 4xx: try to surface a JSON `detail` field if it looks like a clean sentence.
  if (detail.startsWith('{')) {
    try {
      const parsed = JSON.parse(detail) as { detail?: unknown; message?: unknown };
      const candidate = typeof parsed.detail === 'string' ? parsed.detail
        : typeof parsed.message === 'string' ? parsed.message
        : '';
      if (candidate && candidate.length < 240 && !candidate.includes('Traceback')) {
        return { userMessage: candidate, detail };
      }
    } catch { /* fall through */ }
  }
  // Plain string body, short and sane?
  if (detail && detail.length < 240 && !detail.includes('Traceback') && !detail.startsWith('<')) {
    return { userMessage: detail, detail };
  }
  return { userMessage: _genericForStatus(status), detail };
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${DASHBOARD_BASE}${path}`;
  let res: Response;
  try {
    // authFetch routes via the central wrapper so every authenticated
    // dashboard call sends ``credentials: 'include'`` (cookie travels)
    // AND keeps the legacy Bearer fallback from localStorage. Backend
    // dual-accepts either; phase 4 drops Bearer entirely.
    res = await authFetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...options?.headers },
    });
  } catch (e) {
    // Log the raw cause for the developer console; surface a clean message.
    if (typeof console !== 'undefined') console.warn('[fetchJson]', url, e);
    throw new ApiError({
      status: 0,
      userMessage: _genericForStatus(0),
      detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (typeof console !== 'undefined') console.warn('[fetchJson]', url, res.status, text);
    // Admin sudo-mode: detect the backend's "admin password required" rejection
    // and dispatch a global event so AdminGate re-pops the unlock modal.
    // Also wipe the locally-stored admin_token so the next call doesn't keep
    // sending a known-bad one.
    if (res.status === 401 && text.includes('admin_unlock_required')) {
      if (typeof window !== 'undefined') {
        try {
          window.sessionStorage.removeItem('vocence.admin_token');
          window.sessionStorage.removeItem('vocence.admin_token_expires_at');
        } catch { /* ignore */ }
        window.dispatchEvent(new Event('admin-unlock-required'));
      }
    }
    const { userMessage, detail } = _extractUserMessage(res.status, text);
    throw new ApiError({ status: res.status, userMessage, detail });
  }
  return res.json();
}

/** Convenience: pull a display-safe message from any thrown error. */
export function humanizeApiError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof ApiError) return e.userMessage || fallback;
  if (typeof e === 'object' && e && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    const msg = (e as { message: string }).message;
    if (msg.includes('Traceback') || msg.length > 240) return fallback;
    return msg;
  }
  return fallback;
}

export interface DashboardOverview {
  total_miners: number;
  valid_miners: number;
  total_validators: number;
  total_evaluations: number;
  last_activity: string | null;
}

export interface DashboardMiner {
  uid: number;
  hotkey: string;
  block: number | null;
  model_name: string | null;
  model_revision: string | null;
  chute_id: string | null;
  chute_slug: string | null;
  is_valid: boolean;
  invalid_reason: string | null;
  last_validated_at: string | null;
  total_evaluations: number;
  total_wins: number;
  win_rate: number;
}

export interface DashboardValidator {
  uid: number;
  hotkey: string;
  stake: number;
  s3_bucket: string | null;
  last_seen_at: string | null;
  created_at: string | null;
  is_main?: boolean;
}

export interface ActivityBucket {
  at: string | null;
  count: number;
}

export interface GlobalScoringValidatorDetail {
  validator_hotkey: string;
  bucket_name: string;
  label: string;
  wins: number;
  total: number;
  win_rate: number;
  weight: number;
  display: string;
}

export interface GlobalScoringThresholdCheck {
  prior_hotkey: string;
  prior_block: number;
  prior_rate: number;
  required_rate: number;
  candidate_rate: number;
  passed: boolean;
}

export interface GlobalScoringMiner {
  rank: number;
  hotkey: string;
  uid: number;
  block: number;
  model_name: string | null;
  model_revision: string | null;
  chute_slug: string | null;
  chute_id: string | null;
  weighted_win_rate: number;
  raw_win_rate: number;
  wins: number;
  total: number;
  validator_count: number;
  eligible_validator_count?: number;
  weighted_evals: number;
  eligible: boolean;
  threshold_passed: boolean;
  is_winner: boolean;
  status_reason: string;
  per_validator: GlobalScoringValidatorDetail[];
  threshold_checks: GlobalScoringThresholdCheck[];
}

export interface GlobalScoringActiveValidator {
  hotkey: string;
  bucket_name: string;
  label: string;
  stake: number;
  weight: number;
}

export interface GlobalScoringSnapshot {
  generated_at: string;
  max_evals_for_scoring: number;
  min_evals_to_compete: number;
  min_validator_appearances: number;
  min_evals_per_validator: number;
  threshold_margin: number;
  active_validator_count: number;
  valid_miner_count: number;
  active_validators: GlobalScoringActiveValidator[];
  winner: GlobalScoringMiner | null;
  winner_reason: string | null;
  miners: GlobalScoringMiner[];
}

export interface SubnetGraphNode {
  id: string;
  node_type: string;
  hotkey?: string | null;
  uid?: number | null;
  label: string;
  status: string;
  valid?: boolean | null;
  validator_hotkey?: string | null;
  bucket_name?: string | null;
  stake?: number | null;
  last_seen_at?: string | null;
  last_validated_at?: string | null;
  invalid_reason?: string | null;
}

export interface SubnetGraphActivity {
  activity_type: string;
  activity_key: string;
  validator_hotkey: string;
  status: string;
  payload: Record<string, unknown>;
  started_at: string;
  expires_at: string;
}

export interface SubnetGraphSnapshot {
  generated_at: string;
  nodes: SubnetGraphNode[];
  activities: SubnetGraphActivity[];
}

export interface RecentEvaluation {
  id: number;
  validator_hotkey: string;
  evaluation_id: string;
  miner_hotkey: string;
  wins: boolean;
  evaluated_at: string;
  prompt?: string | null;
  reasoning?: string | null;
  original_audio_url?: string | null;
  generated_audio_url?: string | null;
  score?: number | null;
  element_scores?: Record<string, number> | null;
}

/** Canonical element order for rendering per-element score breakdowns. */
export const EVALUATION_ELEMENT_ORDER = [
  "script",
  "naturalness",
  "gender",
  "speed",
  "emotion",
  "age_group",
  "pitch",
  "accent",
  "tone",
] as const;

/** One pending evaluation (validator started, not yet submitted). */
export interface LivePendingItem {
  validator_hotkey: string;
  evaluation_id: string;
  prompt_summary: string | null;
  miner_hotkeys: string[];
  created_at: string;
}

/** Live validation status for all validators (status bar). */
export interface ValidationStatusResponse {
  pending: LivePendingItem[];
  evaluations: RecentEvaluation[];
}

export interface RegisteredUser {
  id: number | string;
  email: string;
  name: string;
  picture: string | null;
  credits?: number | null;
  plan_code?: string | null;
  plan_status?: string | null;
  last_login_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebsiteUsageDay {
  day: string;
  tts_generation_count: number;
  stt_count: number;
  clone_count: number;
  voice_design_count: number;
  music_count: number;
  unique_users: number;
  credits_used: number;
  revenue_usd: number;
  credits_purchased: number;
}

export interface UserRecentActivityItem {
  id: number;
  type: 'tts' | 'stt' | 'clone' | 'voice_design' | 'music';
  created_at: string;
  title: string;
  detail?: string | null;
  credits_used: number;
  status?: string | null;
  audio_url?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  user_name?: string | null;
}

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface JobStatusResponse {
  id: string;
  user_id: string;
  type: 'tts' | 'stt' | 'clone' | 'voice_design' | 'music';
  status: JobStatus;
  phase: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_message: string | null;
  pod_url: string | null;
  credits_charged: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  queue_position: number;
}

export interface UserRecentActivityResponse {
  user_id: string | null;
  items: UserRecentActivityItem[];
  by_day: Array<{ day: string; tts: number; stt: number; clone: number; voice_design: number; music: number }>;
}

export interface PlanDistribution {
  plan_code: string;
  user_count: number;
}

export interface RecentPayment {
  id: string;
  user_id: string;
  provider: string;
  plan_code?: string | null;
  amount_usd: number;
  credits_granted: number;
  status: string;
  created_at: string;
}

export interface WebsiteOverview {
  total_users: number;
  active_users_7d: number;
  total_generations: number;
  total_credits_used: number;
  total_revenue_usd: number;
  usage: WebsiteUsageDay[];
  plan_distribution: PlanDistribution[];
  recent_payments: RecentPayment[];
}

export interface RegisteredUsersListResult {
  users: RegisteredUser[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminTtsHistoryRow {
  id: number;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  miner_hotkey: string;
  model_name: string;
  prompt_text: string;
  style_instruction: string;
  credits_used: number;
  status: string;
  latency_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface AdminPaginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminCreditTransactionRow {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  transaction_type: string;
  amount: number;
  balance_after: number;
  description: string;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface AdminPaymentRow {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  provider: string;
  plan_code: string | null;
  amount_usd: number;
  credits_granted: number;
  status: string;
  mode: string | null;
  stripe_checkout_session_id: string | null;
  credits_applied_at: string | null;
  created_at: string;
}

export interface AdminAuthHistoryRow {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  type: string;
  content: string | null;
  style_prompt: string | null;
  model: string | null;
  meta: string | null;
  duration: string | null;
  created_at: string;
}

export interface AdminUserActivitySummary {
  user_id: string;
  email: string;
  name: string;
  credits: number;
  plan_code: string;
  plan_status: string;
  created_at: string;
  last_login_at: string | null;
  tts_completed_count: number;
  tts_total_credits: number;
  credit_tx_count: number;
  payments_count: number;
  /** Per-user voicechat rate-limit override. null = use platform default.
   *  0 = no cap. The ``_effective`` siblings are the resolved values
   *  (override if set, otherwise platform default) — handy for "Current"
   *  chips in the UI. */
  voicechat_rate_limit_turns: number | null;
  voicechat_rate_limit_window_sec: number | null;
  voicechat_rate_limit_turns_effective: number;
  voicechat_rate_limit_window_sec_effective: number;
  /** Per-user Developer-API rpm override. null = no override; per-key +
   *  env apply. 0 = uncapped. */
  api_rate_limit_rpm: number | null;
  api_rate_limit_rpm_effective: number;
  /** Per-user override for the API WS surface (voice agent, TTS
   *  streaming, STT streaming). 0 = uncapped on that axis. */
  api_ws_opens_per_minute: number | null;
  api_ws_concurrent: number | null;
  api_ws_opens_per_minute_effective: number;
  api_ws_concurrent_effective: number;
}

export interface AdminSetVoicechatRateLimitRequest {
  turns: number | null;
  window_sec: number | null;
  reason?: string;
}

export interface AdminSetApiRateLimitRequest {
  rpm: number | null;
  reason?: string;
}

export interface AdminSetApiWsRateLimitRequest {
  opens_per_minute: number | null;
  concurrent: number | null;
  reason?: string;
}

export interface BlogPost {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  date: string;
  read_time: string;
  image: string;
  content: string;
  featured: boolean;
  created_at?: string | null;
}

export const dashboardApi = {
  getOverview(): Promise<DashboardOverview> {
    return fetchJson('/api/dashboard/overview');
  },

  getMiners(validOnly = true, validatorHotkey?: string | null): Promise<{ miners: DashboardMiner[] }> {
    const params = new URLSearchParams({ valid: validOnly ? 'true' : 'false' });
    if (validatorHotkey?.trim()) params.set('validator_hotkey', validatorHotkey.trim());
    return fetchJson(`/api/dashboard/miners?${params.toString()}`);
  },

  getValidators(): Promise<{ validators: DashboardValidator[] }> {
    return fetchJson('/api/dashboard/validators');
  },

  getActivity(range: '24h' | '7d' = '24h'): Promise<{ range: string; buckets: ActivityBucket[] }> {
    return fetchJson(`/api/dashboard/activity?range=${range}`);
  },

  getGlobalScoring(): Promise<GlobalScoringSnapshot | null> {
    return fetchJson('/api/dashboard/global-scoring');
  },

  getSubnetGraph(): Promise<SubnetGraphSnapshot> {
    return fetchJson('/api/dashboard/subnet-graph');
  },

  getRecentEvaluations(
    limit = 50,
    validatorHotkey?: string | null,
    minerHotkey?: string | null
  ): Promise<{ evaluations: RecentEvaluation[]; total_count: number }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (validatorHotkey?.trim()) params.set('validator_hotkey', validatorHotkey.trim());
    if (minerHotkey?.trim()) params.set('miner_hotkey', minerHotkey.trim());
    return fetchJson(`/api/dashboard/evaluations/recent?${params.toString()}`);
  },

  getEvaluations(
    limit = 100,
    offset = 0,
    validatorHotkey?: string | null,
    minerHotkey?: string | null
  ): Promise<{ evaluations: RecentEvaluation[]; total_count: number }> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (validatorHotkey?.trim()) params.set('validator_hotkey', validatorHotkey.trim());
    if (minerHotkey?.trim()) params.set('miner_hotkey', minerHotkey.trim());
    return fetchJson(`/api/dashboard/evaluations?${params.toString()}`);
  },

  /** Live validation status (pending + recent evaluations) for main validator. */
  getValidationStatus(
    limitPending = 10,
    limitEvaluations = 30
  ): Promise<ValidationStatusResponse> {
    return fetchJson(
      `/api/dashboard/validation-status?limit_pending=${limitPending}&limit_evaluations=${limitEvaluations}`
    );
  },

  getMinersAll(limit = 500): Promise<{ miners: DashboardMiner[] }> {
    return fetchJson(`/api/dashboard/miners?valid=false&limit=${limit}`);
  },

  registerUser(data: { email: string; name?: string; picture?: string }): Promise<RegisteredUser> {
    return fetchJson('/api/dashboard/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: data.email,
        name: data.name ?? '',
        picture: data.picture ?? null,
      }),
    });
  },

  getRegisteredUsers(
    _adminEmail: string,
    opts?: { page?: number; page_size?: number; q?: string }
  ): Promise<RegisteredUsersListResult> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set('page', String(opts.page));
    if (opts?.page_size != null) params.set('page_size', String(opts.page_size));
    if (opts?.q?.trim()) params.set('q', opts.q.trim());
    const qs = params.toString();
    return fetchJson(`/api/dashboard/users${qs ? `?${qs}` : ''}`, {
      headers: adminAuthHeaders(),
    });
  },

  getAdminWebsiteUsageTts(
    _adminEmail: string,
    opts?: { page?: number; page_size?: number; q?: string; user_id?: string | null }
  ): Promise<AdminPaginated<AdminTtsHistoryRow>> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set('page', String(opts.page));
    if (opts?.page_size != null) params.set('page_size', String(opts.page_size));
    if (opts?.q?.trim()) params.set('q', opts.q.trim());
    if (opts?.user_id?.trim()) params.set('user_id', opts.user_id.trim());
    return fetchJson(`/api/dashboard/admin/website-usage/tts?${params.toString()}`, {
      headers: adminAuthHeaders(),
    });
  },

  getAdminWebsiteUsageCredits(
    _adminEmail: string,
    opts?: { page?: number; page_size?: number; q?: string; user_id?: string | null }
  ): Promise<AdminPaginated<AdminCreditTransactionRow>> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set('page', String(opts.page));
    if (opts?.page_size != null) params.set('page_size', String(opts.page_size));
    if (opts?.q?.trim()) params.set('q', opts.q.trim());
    if (opts?.user_id?.trim()) params.set('user_id', opts.user_id.trim());
    return fetchJson(`/api/dashboard/admin/website-usage/credits?${params.toString()}`, {
      headers: adminAuthHeaders(),
    });
  },

  getAdminWebsiteUsagePayments(
    _adminEmail: string,
    opts?: { page?: number; page_size?: number; q?: string; user_id?: string | null }
  ): Promise<AdminPaginated<AdminPaymentRow>> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set('page', String(opts.page));
    if (opts?.page_size != null) params.set('page_size', String(opts.page_size));
    if (opts?.q?.trim()) params.set('q', opts.q.trim());
    if (opts?.user_id?.trim()) params.set('user_id', opts.user_id.trim());
    return fetchJson(`/api/dashboard/admin/website-usage/payments?${params.toString()}`, {
      headers: adminAuthHeaders(),
    });
  },

  getAdminWebsiteUsageAuthHistory(
    _adminEmail: string,
    opts?: { page?: number; page_size?: number; q?: string; user_id?: string | null }
  ): Promise<AdminPaginated<AdminAuthHistoryRow>> {
    const params = new URLSearchParams();
    if (opts?.page != null) params.set('page', String(opts.page));
    if (opts?.page_size != null) params.set('page_size', String(opts.page_size));
    if (opts?.q?.trim()) params.set('q', opts.q.trim());
    if (opts?.user_id?.trim()) params.set('user_id', opts.user_id.trim());
    return fetchJson(`/api/dashboard/admin/website-usage/auth-history?${params.toString()}`, {
      headers: adminAuthHeaders(),
    });
  },

  getAdminUserActivitySummary(_adminEmail: string, userId: string): Promise<AdminUserActivitySummary> {
    return fetchJson(`/api/dashboard/admin/website-usage/user/${encodeURIComponent(userId)}/summary`, {
      headers: adminAuthHeaders(),
    });
  },

  setAdminUserVoicechatRateLimit(
    userId: string,
    body: AdminSetVoicechatRateLimitRequest,
  ): Promise<AdminUserActivitySummary> {
    return fetchJson(
      `/api/dashboard/admin/website-usage/user/${encodeURIComponent(userId)}/voicechat-rate-limit`,
      {
        method: 'PATCH',
        headers: { ...adminAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  setAdminUserApiRateLimit(
    userId: string,
    body: AdminSetApiRateLimitRequest,
  ): Promise<AdminUserActivitySummary> {
    return fetchJson(
      `/api/dashboard/admin/website-usage/user/${encodeURIComponent(userId)}/api-rate-limit`,
      {
        method: 'PATCH',
        headers: { ...adminAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  setAdminUserApiWsRateLimit(
    userId: string,
    body: AdminSetApiWsRateLimitRequest,
  ): Promise<AdminUserActivitySummary> {
    return fetchJson(
      `/api/dashboard/admin/website-usage/user/${encodeURIComponent(userId)}/api-ws-rate-limit`,
      {
        method: 'PATCH',
        headers: { ...adminAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  },

  getAdminUserRecentActivity(
    _adminEmail: string,
    userId: string,
    limit = 100,
  ): Promise<UserRecentActivityResponse> {
    return fetchJson(
      `/api/dashboard/admin/website-usage/user/${encodeURIComponent(userId)}/recent-activity?limit=${limit}`,
      { headers: adminAuthHeaders() },
    );
  },

  getAdminRecentActivity(
    _adminEmail: string,
    opts?: { limit?: number; user_id?: string | null },
  ): Promise<UserRecentActivityResponse> {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.user_id?.trim()) params.set('user_id', opts.user_id.trim());
    const qs = params.toString();
    return fetchJson(`/api/dashboard/admin/recent-activity${qs ? `?${qs}` : ''}`, {
      headers: adminAuthHeaders(),
    });
  },

  getWebsiteOverview(_adminEmail: string): Promise<WebsiteOverview> {
    return fetchJson('/api/dashboard/website-overview', {
      headers: adminAuthHeaders(),
    });
  },

  addValidator(
    data: { uid: number; hotkey: string; stake?: number; s3_bucket?: string },
    _adminEmail: string
  ): Promise<DashboardValidator> {
    return fetchJson('/api/dashboard/validators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminAuthHeaders() },
      body: JSON.stringify({
        uid: data.uid,
        hotkey: data.hotkey,
        stake: data.stake ?? 0,
        s3_bucket: data.s3_bucket ?? null,
      }),
    });
  },

  removeValidator(uid: number, _adminEmail: string): Promise<{ ok: boolean }> {
    return fetchJson(`/api/dashboard/validators/${uid}`, {
      method: 'DELETE',
      headers: adminAuthHeaders(),
    });
  },

  getBlocklist(): Promise<{ hotkeys: string[] }> {
    return fetchJson('/api/dashboard/blocklist');
  },

  addBlocklist(hotkey: string, _adminEmail: string): Promise<{ hotkeys: string[] }> {
    return fetchJson('/api/dashboard/blocklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminAuthHeaders() },
      body: JSON.stringify({ hotkey }),
    });
  },

  removeBlocklist(hotkey: string, _adminEmail: string): Promise<{ ok: boolean }> {
    return fetchJson(`/api/dashboard/blocklist/${encodeURIComponent(hotkey)}`, {
      method: 'DELETE',
      headers: adminAuthHeaders(),
    });
  },

  getBlogPosts(limit = 12, offset = 0): Promise<{ posts: BlogPost[]; total: number }> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return fetchJson(`/api/dashboard/blog?${params.toString()}`);
  },

  getBlogPost(id: string): Promise<BlogPost> {
    return fetchJson(`/api/dashboard/blog/${id}`);
  },

  uploadBlogImage(file: File, _adminEmail: string): Promise<{ url: string }> {
    const form = new FormData();
    form.append('file', file);
    return authFetch(`${DASHBOARD_BASE}/api/dashboard/blog/upload`, {
      method: 'POST',
      headers: adminAuthHeaders(),
      body: form,
    }).then(async (res) => {
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      return res.json();
    });
  },

  createBlogPost(
    data: { title: string; excerpt: string; category: string; read_time?: string; image: string; content: string; featured?: boolean },
    _adminEmail: string
  ): Promise<BlogPost> {
    return fetchJson('/api/dashboard/blog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminAuthHeaders() },
      body: JSON.stringify({
        title: data.title,
        excerpt: data.excerpt,
        category: data.category,
        read_time: data.read_time ?? '5 min read',
        image: data.image,
        content: data.content,
        featured: data.featured ?? false,
      }),
    });
  },

  updateBlogPost(
    id: string,
    data: { title: string; excerpt: string; category: string; read_time?: string; image: string; content: string; featured?: boolean },
    _adminEmail: string
  ): Promise<BlogPost> {
    return fetchJson(`/api/dashboard/blog/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...adminAuthHeaders() },
      body: JSON.stringify({
        title: data.title,
        excerpt: data.excerpt,
        category: data.category,
        read_time: data.read_time ?? '5 min read',
        image: data.image,
        content: data.content,
        featured: data.featured ?? false,
      }),
    });
  },

  deleteBlogPost(id: string, _adminEmail: string): Promise<{ ok: boolean }> {
    return fetchJson(`/api/dashboard/blog/${id}`, {
      method: 'DELETE',
      headers: adminAuthHeaders(),
    });
  },

  // ----- Studio TTS -----
  getStudioTopModels(limit = 3): Promise<{ models: StudioTopModel[] }> {
    return fetchJson(`/api/dashboard/studio/top-models?limit=${limit}`);
  },

  generateStudioTts(
    body: {
      user_id: string;
      miner_hotkey: string;
      model_name: string;
      chute_id: string;
      chute_slug: string;
      text: string;
      style_instruction?: string | null;
    },
    token: string | null
  ): Promise<StudioGenerateResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  /**
   * Generate TTS using a pre-stored sample voice. Backend uses voice cloning
   * under the hood with the matching reference clip; charged at TTS price.
   */
  generateStudioTtsSampleVoice(
    body: {
      sample_voice_id: string;
      target_text: string;
      target_language?: string | null;
    },
    token: string | null
  ): Promise<StudioCloneResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/tts/voice-clone-sample', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  generateStudioStt(
    body: { user_id: string; language?: string | null; audio_file: File },
    token: string | null
  ): Promise<StudioTranscribeResponse> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const form = new FormData();
    form.append('user_id', body.user_id);
    if (body.language?.trim()) {
      form.append('language', body.language.trim());
    }
    form.append('audio_file', body.audio_file);
    return fetchJson('/api/dashboard/studio/transcribe', {
      method: 'POST',
      headers,
      body: form,
    });
  },

  generateStudioClone(
    body: {
      user_id: string;
      target_text: string;
      ref_source: 'upload' | 'record';
      language?: string | null;
      audio_file: File;
      reference_text?: string | null;
    },
    token: string | null
  ): Promise<StudioCloneResponse> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const form = new FormData();
    form.append('user_id', body.user_id);
    form.append('target_text', body.target_text.trim());
    form.append('ref_source', body.ref_source);
    if (body.language?.trim()) {
      form.append('language', body.language.trim());
    }
    if (body.reference_text?.trim()) {
      form.append('reference_text', body.reference_text.trim());
    }
    form.append('audio_file', body.audio_file);
    return fetchJson('/api/dashboard/studio/clone', {
      method: 'POST',
      headers,
      body: form,
    });
  },

  getStudioHistory(userId: string): Promise<{ items: StudioHistoryItem[] }> {
    return fetchJson(`/api/dashboard/studio/history?user_id=${encodeURIComponent(userId)}`, {
      headers: adminAuthHeaders(),
    });
  },

  deleteStudioHistory(
    items: Array<{ id: number; type: 'tts' | 'stt' | 'clone' | 'voice_design' | 'music' | 'noise_remover' }>,
    token: string | null,
  ): Promise<{ deleted: number }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/history/delete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ items }),
    });
  },

  getStudioHistoryAudioUrl(
    historyId: number,
    userId: string,
    entryType: 'tts' | 'clone' | 'voice_design' | 'music' = 'tts'
  ): Promise<{ audio_url: string }> {
    const et =
      entryType === 'clone'
        ? '&entry_type=clone'
        : entryType === 'voice_design'
          ? '&entry_type=voice_design'
          : entryType === 'music'
            ? '&entry_type=music'
            : '';
    return fetchJson(
      `/api/dashboard/studio/history/${historyId}/audio-url?user_id=${encodeURIComponent(userId)}${et}`,
      { headers: adminAuthHeaders() },
    );
  },

  getStudioVoiceDesignConfig(): Promise<StudioVoiceDesignConfig> {
    return fetchJson('/api/dashboard/studio/voice-design/config');
  },

  studioVoiceDesignPreview(
    body: {
      user_id: string;
      voice_description: string;
      miner_hotkey: string;
      model_name: string;
      chute_id: string;
      chute_slug: string;
    },
    token: string | null
  ): Promise<StudioVoiceDesignPreviewResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/voice-design/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  studioVoiceDesignSave(
    body: { user_id: string; preview_token: string; chosen_variant: 'original' | 'revised'; display_name: string },
    token: string | null
  ): Promise<StudioVoiceDesignSaveResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/voice-design/save', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  listStudioDesignedVoices(token: string | null): Promise<{ voices: StudioDesignedVoiceItem[] }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/voice-design/voices', { headers });
  },

  deleteStudioDesignedVoice(voiceId: number, token: string | null): Promise<{ ok: boolean }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/studio/voice-design/voices/${voiceId}`, {
      method: 'DELETE',
      headers,
    });
  },

  /** Upload a voice clip and save it as a reusable "cloned" voice in My
   *  Voices. The backend transcribes the clip once on save and stores both
   *  the reference audio (long-retention R2 object) and transcription. The
   *  returned voice_id is selectable as `dv:<voice_id>` anywhere voices are
   *  used (agents, Studio clone target, designed-voice speak). */
  saveStudioClonedVoice(
    args: { displayName: string; audioFile: File; language?: string; referenceText?: string },
    token: string | null,
  ): Promise<StudioClonedVoiceSaveResponse> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const form = new FormData();
    form.append('display_name', args.displayName);
    form.append('audio_file', args.audioFile);
    if (args.language) form.append('language', args.language);
    if (args.referenceText) form.append('reference_text', args.referenceText);
    return fetchJson('/api/dashboard/studio/voice-design/cloned-voices', {
      method: 'POST',
      headers,
      body: form,
    });
  },

  studioDesignedVoiceSpeak(
    body: { user_id: string; voice_id: number; target_text: string },
    token: string | null
  ): Promise<StudioCloneResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/voice-design/speak', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  // ----- Studio Music -----

  generateStudioMusicText2Music(
    body: {
      user_id: string;
      prompt: string;
      lyrics?: string;
      audio_duration?: number;
      format?: string;
      infer_step?: number;
      guidance_scale?: number;
      scheduler_type?: string;
      cfg_type?: string;
      omega_scale?: number;
      manual_seeds?: string;
      guidance_interval?: number;
      guidance_interval_decay?: number;
      min_guidance_scale?: number;
      use_erg_tag?: boolean;
      use_erg_lyric?: boolean;
      use_erg_diffusion?: boolean;
      oss_steps?: string;
      guidance_scale_text?: number;
      guidance_scale_lyric?: number;
      lora_name_or_path?: string;
    },
    token: string | null
  ): Promise<StudioMusicGenerateResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/music/text2music', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  generateStudioMusicWithAudio(
    endpoint: 'audio2audio' | 'retake' | 'repaint' | 'edit' | 'extend',
    formData: FormData,
    token: string | null
  ): Promise<StudioMusicGenerateResponse> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/studio/music/${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
    });
  },

  /** Upload the source/reference audio for retake/repaint/edit/extend/audio2audio
   * to the backend bucket. Returns ``{src_audio_bucket, src_audio_key}`` which
   * the caller passes inside the /jobs/start payload, keeps the job payload
   * tiny (no base64) so all 6 music tasks behave identically over the wire.
   * @deprecated prefer ``presignUpload`` + direct PUT so the bytes skip the
   * Cloudflare proxy entirely. Kept for backward compat. */
  uploadStudioMusicSource(
    userId: string,
    file: File,
    token: string | null,
  ): Promise<{ src_audio_bucket: string; src_audio_key: string; src_audio_filename: string }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const form = new FormData();
    form.append('user_id', userId);
    form.append('src_audio', file, file.name);
    return fetchJson('/api/dashboard/studio/music/upload-source', {
      method: 'POST',
      headers,
      body: form,
    });
  },

  /** Ask the backend for a presigned PUT URL pointing directly at R2.
   *  The browser then PUTs the file straight to R2, the bytes do NOT
   *  traverse the API's Cloudflare proxy, so we sidestep the per-request
   *  body-size limits and large HTTP/2 upload stalls that plague big
   *  multipart POSTs to ``backend.vocence.ai``. The caller passes the
   *  returned ``key`` into whichever job/start endpoint needs it. */
  presignUpload(
    body: { kind: 'music-source' | 'playbook-audio' | 'voice-clone-ref' | 'stt-source'; filename: string; content_type?: string; size: number },
    token: string | null,
  ): Promise<{ put_url: string; bucket: string; key: string; filename: string; expires_at: string; max_bytes: number }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/uploads/presign', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  /** Convenience: presign + PUT in one call. Returns the bucket/key the
   *  caller should put in the job payload. PUT goes browser → R2 directly
   *  so it bypasses Cloudflare and isn't subject to your API's body limits. */
  async uploadDirectToR2(
    kind: 'music-source' | 'playbook-audio' | 'voice-clone-ref' | 'stt-source',
    file: File,
    token: string | null,
  ): Promise<{ bucket: string; key: string; filename: string }> {
    const presigned = await this.presignUpload(
      { kind, filename: file.name, content_type: file.type || 'application/octet-stream', size: file.size },
      token,
    );
    // Third-party object storage (R2/S3 presigned URL). MUST NOT send
    // credentials — presigned URLs are pre-signed; cookies would be
    // ignored at best, rejected at worst. Use bare fetch.
    const putRes = await fetch(presigned.put_url, {
      method: 'PUT',
      body: file,
      headers: file.type ? { 'Content-Type': file.type } : undefined,
    });
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => '');
      throw new Error(`Upload to storage failed (${putRes.status}): ${text.slice(0, 200)}`);
    }
    return { bucket: presigned.bucket, key: presigned.key, filename: presigned.filename };
  },

  /** AI-generate lyrics from a topic. Free; no credits charged. The
   * server uses the same LLM router as agents and enforces the
   * ACE-Step structure-tag format ([verse]/[chorus]/...). */
  generateStudioMusicLyrics(
    body: { topic: string; prompt?: string; section_count?: number },
    token: string | null
  ): Promise<{ lyrics: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/studio/music/generate-lyrics', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  getStudioMusicHistory(userId: string): Promise<{ items: StudioMusicHistoryItem[] }> {
    return fetchJson(`/api/dashboard/studio/music/history?user_id=${encodeURIComponent(userId)}`, {
      headers: adminAuthHeaders(),
    });
  },

  getStudioMusicHistoryAudioUrl(historyId: number, userId: string): Promise<{ audio_url: string }> {
    return fetchJson(
      `/api/dashboard/studio/music/history/${historyId}/audio-url?user_id=${encodeURIComponent(userId)}`,
      { headers: adminAuthHeaders() },
    );
  },

  // ----- Playbooks -----

  createPlaybook(body: { title?: string; description?: string }, token: string | null): Promise<Playbook> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/playbooks', { method: 'POST', headers, body: JSON.stringify(body) });
  },

  browsePublicPlaybooks(limit = 20, token?: string | null): Promise<{ playbooks: PublicPlaybook[] }> {
    // Auth is optional: when a token is supplied each item's
    // ``viewer_voted`` reflects whether the signed-in user already
    // thumbed it; anonymous callers always see viewer_voted = false.
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/public/browse?limit=${limit}`, { headers });
  },

  votePlaybook(id: number, token: string | null): Promise<{ vote_count: number; viewer_voted: boolean }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}/vote`, { method: 'POST', headers });
  },

  unvotePlaybook(id: number, token: string | null): Promise<{ vote_count: number; viewer_voted: boolean }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}/vote`, { method: 'DELETE', headers });
  },

  recordPlaybookPlay(id: number, token?: string | null): Promise<{ play_count: number }> {
    // Auth is optional. Anonymous viewers (via shared links) get
    // counted too; private playbooks silently no-op server-side.
    // Callers should fire-and-forget, the play UI shouldn't wait
    // on the increment to complete.
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}/play`, { method: 'POST', headers });
  },

  listPlaybooks(token: string | null): Promise<{ playbooks: Playbook[] }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/playbooks', { headers });
  },

  getPlaybook(id: number, token: string | null): Promise<PlaybookDetail> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}`, { headers });
  },

  updatePlaybook(id: number, body: { title?: string; description?: string; visibility?: string; cover_image_url?: string | null }, token: string | null): Promise<Playbook> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  },

  uploadPlaybookCover(id: number, blob: Blob, token: string | null): Promise<Playbook> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const form = new FormData();
    form.append('image', blob, 'cover.png');
    return fetchJson(`/api/dashboard/playbooks/${id}/cover`, { method: 'POST', headers, body: form });
  },

  // ─── Generation jobs (queued, polled) ──────────────────────────────────
  startJob(
    body: { type: 'tts' | 'stt' | 'clone' | 'voice_design' | 'music'; payload: Record<string, unknown>; credits?: number },
    token: string | null,
  ): Promise<{ job_id: string; status: string; queue_position: number; load_warning: boolean; pool_snapshots: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/jobs/start', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  getJob(jobId: string, token: string | null): Promise<JobStatusResponse> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/jobs/${encodeURIComponent(jobId)}`, { headers });
  },

  cancelJob(jobId: string, token: string | null): Promise<{ cancelled: boolean }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers });
  },

  listUserJobs(token: string | null, limit = 50): Promise<{ items: JobStatusResponse[] }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/jobs?limit=${limit}`, { headers });
  },

  deletePlaybook(id: number, token: string | null): Promise<{ ok: boolean }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}`, { method: 'DELETE', headers });
  },

  addPlaybookTracks(
    id: number,
    tracks: { title: string; subtitle?: string; audio_url: string; image_url?: string; source_type?: string; duration_seconds?: number }[],
    token: string | null
  ): Promise<PlaybookDetail> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}/tracks`, { method: 'POST', headers, body: JSON.stringify({ tracks }) });
  },

  removePlaybookTrack(playbookId: number, trackId: number, token: string | null): Promise<{ ok: boolean }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${playbookId}/tracks/${trackId}`, { method: 'DELETE', headers });
  },

  reorderPlaybookTracks(playbookId: number, trackIds: number[], token: string | null): Promise<{ ok: boolean }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${playbookId}/tracks/reorder`, { method: 'PATCH', headers, body: JSON.stringify({ track_ids: trackIds }) });
  },

  uploadPlaybookTrack(playbookId: number, file: File, title: string, token: string | null): Promise<PlaybookDetail> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const form = new FormData();
    form.append('title', title);
    form.append('audio_file', file);
    return fetchJson(`/api/dashboard/playbooks/${playbookId}/upload`, { method: 'POST', headers, body: form });
  },

  /** Two-step upload: PUT the file directly to R2 (no Cloudflare in the path)
   * then register the track on the backend with the resulting key. Use this
   * for any file you want to skip the API proxy for, supports up to the
   * presign endpoint's cap (300 MB by default). */
  async uploadPlaybookTrackDirect(
    playbookId: number,
    file: File,
    title: string,
    token: string | null,
  ): Promise<PlaybookDetail> {
    const { bucket, key, filename } = await this.uploadDirectToR2('playbook-audio', file, token);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${playbookId}/upload-from-r2`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, bucket, key, filename }),
    });
  },

  // ----- Generation feedback (thumbs up/down) -----

  /** Submit / replace the current user's thumb for one generation result.
   *  Pass rating=0 to clear an existing vote (so the user can un-thumb
   *  by clicking the active arrow again). */
  submitGenerationFeedback(
    body: {
      entry_type:
        | 'tts' | 'stt' | 'clone' | 'voice_design' | 'music'
        | 'noise_remover' | 'agent_call' | 'agent_message';
      entry_id: string;
      rating: -1 | 0 | 1;
      comment?: string;
    },
    token: string | null,
  ): Promise<{ ok: true; rating: number }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/feedback', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  },

  /** Look up the current user's thumb for one entry, used to pre-paint
   *  the UI on result-page load so a previous vote is reflected. Returns
   *  rating=0 when no vote exists. */
  getMyGenerationFeedback(
    entry_type: string,
    entry_id: string,
    token: string | null,
  ): Promise<{ rating: number; comment: string | null; created_at?: string; updated_at?: string }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const qs = new URLSearchParams({ entry_type, entry_id });
    return fetchJson(`/api/dashboard/feedback?${qs}`, { headers });
  },

  // ----- Agent knowledge (external sources via the knowledge-ingestion pod) -----

  listAgentKnowledgeSources(
    agentId: string, token: string | null,
  ): Promise<{ sources: KnowledgeSource[] }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/agents/${agentId}/knowledge/sources`, { headers });
  },

  deleteAgentKnowledgeSource(
    agentId: string, sourceId: string, token: string | null,
  ): Promise<{ deleted: boolean; chunks_removed: number }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/agents/${agentId}/knowledge/sources/${sourceId}`, {
      method: 'DELETE', headers,
    });
  },

  ingestAgentKnowledgeText(
    agentId: string, body: { content: string; title?: string }, token: string | null,
  ): Promise<KnowledgeIngestResponse> {
    return _postJson(`/api/dashboard/agents/${agentId}/knowledge/ingest/text`, body, token);
  },

  ingestAgentKnowledgeMarkdown(
    agentId: string, body: { content: string; title?: string }, token: string | null,
  ): Promise<KnowledgeIngestResponse> {
    return _postJson(`/api/dashboard/agents/${agentId}/knowledge/ingest/markdown`, body, token);
  },

  ingestAgentKnowledgeUrl(
    agentId: string,
    body: { url: string; title?: string; max_depth?: 0 | 1 },
    token: string | null,
  ): Promise<KnowledgeIngestResponse> {
    return _postJson(`/api/dashboard/agents/${agentId}/knowledge/ingest/url`, body, token);
  },

  ingestAgentKnowledgeSitemap(
    agentId: string,
    body: { url: string; title?: string; include?: string[]; exclude?: string[]; max_pages?: number },
    token: string | null,
  ): Promise<KnowledgeIngestResponse> {
    return _postJson(`/api/dashboard/agents/${agentId}/knowledge/ingest/sitemap`, body, token);
  },

  /** PDF ingest uses multipart/form-data because the file body is binary. */
  ingestAgentKnowledgePdf(
    agentId: string, args: { file: File; title?: string }, token: string | null,
  ): Promise<KnowledgeIngestResponse> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const form = new FormData();
    form.append('file', args.file);
    if (args.title) form.append('title', args.title);
    return fetchJson(`/api/dashboard/agents/${agentId}/knowledge/ingest/pdf`, {
      method: 'POST', headers, body: form,
    });
  },

  getAgentKnowledgeJob(
    agentId: string, jobId: string, token: string | null,
  ): Promise<KnowledgeJob> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/agents/${agentId}/knowledge/jobs/${jobId}`, { headers });
  },

  // ----- Embed tokens (anonymous-visitor widget access to an agent) -----

  createAgentEmbedToken(
    agentId: string,
    body: {
      label?: string;
      allowed_origins?: string[];
      rate_limit_per_ip_per_hour?: number;
      max_session_minutes?: number;
    },
    token: string | null,
  ): Promise<{
    token: EmbedTokenRow;
    plaintext: string;
    embed_snippet: string;
  }> {
    return _postJson(`/api/dashboard/agents/${agentId}/embed-tokens`, body, token);
  },

  listAgentEmbedTokens(
    agentId: string, token: string | null,
  ): Promise<{ tokens: EmbedTokenRow[] }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/agents/${agentId}/embed-tokens`, { headers });
  },

  revokeAgentEmbedToken(
    agentId: string, tokenId: string, token: string | null,
  ): Promise<{ ok: true }> {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/agents/${agentId}/embed-tokens/${tokenId}`, {
      method: 'DELETE', headers,
    });
  },

  // -------------------------------------------------------------------
  // Voice submissions, user-contributed voices for Community Voices.
  // -------------------------------------------------------------------

  submitVoice(form: FormData, token: string): Promise<VoiceSubmission> {
    // Multipart upload, DON'T set Content-Type, the browser fills in
    // the multipart boundary automatically.
    return fetchJson(`/api/dashboard/voice-submissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  },

  listMyVoiceSubmissions(token: string): Promise<{ submissions: VoiceSubmission[] }> {
    return fetchJson(`/api/dashboard/voice-submissions/mine`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  adminListVoiceSubmissions(
    statusFilter: 'all' | 'pending' | 'approved' | 'rejected' = 'all',
  ): Promise<{ submissions: AdminVoiceSubmission[]; pending_count: number }> {
    return fetchJson(
      `/api/dashboard/admin/voice-submissions?status_filter=${statusFilter}`,
      { headers: adminAuthHeaders() },
    );
  },

  adminApproveVoiceSubmission(
    submissionId: string,
  ): Promise<{ ok: true; approved_voice_id: string; credits_granted: number }> {
    return fetchJson(
      `/api/dashboard/admin/voice-submissions/${submissionId}/approve`,
      { method: 'POST', headers: adminAuthHeaders() },
    );
  },

  adminRejectVoiceSubmission(
    submissionId: string, reason: string,
  ): Promise<{ ok: true }> {
    return fetchJson(
      `/api/dashboard/admin/voice-submissions/${submissionId}/reject`,
      {
        method: 'POST',
        headers: { ...adminAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );
  },

  // -------------------------------------------------------------------
  // Notifications, bell + admin composer.
  // -------------------------------------------------------------------

  listNotifications(
    limit: number, offset: number, token: string,
  ): Promise<NotificationListResponse> {
    return fetchJson(
      `/api/dashboard/notifications?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  },

  getUnreadNotificationCount(token: string): Promise<{ unread_count: number }> {
    return fetchJson(`/api/dashboard/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  markNotificationRead(
    notificationId: string, token: string,
  ): Promise<{ ok: true; updated: number }> {
    return fetchJson(
      `/api/dashboard/notifications/${notificationId}/read`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
  },

  markAllNotificationsRead(token: string): Promise<{ ok: true; updated: number }> {
    return fetchJson(`/api/dashboard/notifications/read-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  adminSendNotification(body: AdminSendNotificationBody): Promise<{ sent: number }> {
    return fetchJson(`/api/dashboard/admin/notifications/send`, {
      method: 'POST',
      headers: { ...adminAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  adminUploadNotificationImage(file: File): Promise<{ url: string }> {
    const form = new FormData();
    form.append('image', file);
    // Multipart upload, DON'T set Content-Type, the browser fills in
    // the multipart boundary automatically. Auth headers stay.
    return fetchJson(`/api/dashboard/admin/notifications/upload-image`, {
      method: 'POST',
      headers: adminAuthHeaders(),
      body: form,
    });
  },
};

// Voice-submission + notification types match the backend Pydantic
// models in voice_submissions.py / notifications.py.

export interface VoiceSubmission {
  id: string;
  name: string;
  description: string;
  ref_text: string;
  language: string;
  audio_url: string;
  audio_duration_ms: number;
  avatar_url: string;
  status: 'pending' | 'approved' | 'rejected';
  reject_reason: string | null;
  reviewed_at: string | null;
  approved_voice_id: string | null;
  created_at: string;
}

export interface AdminVoiceSubmission extends VoiceSubmission {
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  reviewed_by: string | null;
}

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  image_url: string | null;
  sender: string | null;
  read: boolean;
  created_at: string;
}

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unread_count: number;
  has_more: boolean;
}

export interface AdminSendNotificationBody {
  title: string;
  body: string;
  link?: string | null;
  image_url?: string | null;
  audience: 'all' | 'user_ids' | 'premium';
  user_ids?: string[];
  kind?: string;
}

// ---------------------------------------------------------------------------
// Helpers + types for the additions above
// ---------------------------------------------------------------------------

/** Internal: JSON POST with bearer auth. Inlined here rather than in the
 *  ``dashboardApi`` object because TypeScript would otherwise need an
 *  explicit ``this`` type, simpler to use a free function. */
function _postJson<T>(path: string, body: unknown, token: string | null): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetchJson(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

export interface KnowledgeSource {
  source_id: string;
  source_title: string;
  chunks: number;
  ingested_at: string;
}

export interface KnowledgeIngestResponse {
  status: 'completed' | 'pending';
  source_id: string;
  job_id?: string;           // pending only
  chunk_count?: number;      // completed only
  tokens_indexed?: number;   // completed only
}

export interface KnowledgeJob {
  job_id: string;
  source_id: string;
  agent_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  phase: string | null;
  chunks_so_far: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface EmbedTokenRow {
  id: string;
  token_prefix: string;       // 'vet_ab' style preview, never the plaintext
  label: string;
  allowed_origins: string[];
  rate_limit_per_ip_per_hour: number;
  max_session_minutes: number;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface StudioTopModel {
  miner_hotkey: string;
  model_name: string;
  display_name: string;
  chute_id: string;
  chute_slug: string;
}

export interface StudioGenerateResponse {
  id: number;
  audio_url: string;
  expires_at: string;
  credits: number;
}

export interface StudioTranscribeResponse {
  id: number;
  text: string;
  language?: string | null;
  credits: number;
  duration_seconds?: number | null;
}

export interface StudioCloneResponse {
  id: number;
  audio_url: string;
  expires_at: string;
  credits: number;
  reference_text: string;
  detected_language?: string | null;
}

export interface StudioMusicGenerateResponse {
  id: number;
  audio_url: string;
  expires_at: string;
  credits: number;
  task: string;
}

export interface StudioMusicHistoryItem {
  id: number;
  entry_type: 'music';
  task: string;
  prompt_text: string;
  lyrics: string;
  audio_duration: number;
  audio_url: string | null;
  expires_at: string;
  created_at: string;
  expired: boolean;
  metadata_json: string;
}

export interface StudioHistoryItem {
  id: number;
  entry_type: 'tts' | 'stt' | 'clone' | 'voice_design' | 'music' | 'noise_remover' | 'dubbing';
  miner_hotkey: string;
  model_name: string;
  display_name: string;
  prompt_text: string | null;
  style_instruction: string;
  audio_url: string | null;
  expires_at: string;
  created_at: string;
  expired: boolean;
  transcribed_text?: string | null;
  source_audio_filename?: string | null;
  source_language?: string | null;
  duration_seconds?: number | null;
  reference_text?: string | null;
  target_text?: string | null;
  clone_source?: string | null;
  // Music-only metadata. ``music_task`` is the generation type
  // ('text2music' | 'audio2audio' | 'retake' | 'repaint' | 'edit' |
  // 'extend'); ``music_metadata_json`` is a JSON string of the
  // task-specific params (variance, repaint window, edit target, etc.).
  // The history UI parses it lazily to render mode-specific rows and
  // copy-buttons. Always null for non-music entries.
  lyrics?: string | null;
  music_task?: string | null;
  music_metadata_json?: string | null;
}

export interface StudioVoiceDesignConfig {
  llm_configured: boolean;
  preview_credits: number;
  sample_words_min: number;
  sample_words_max: number;
}

export interface StudioVoiceDesignPreviewResponse {
  preview_token: string;
  sample_script: string;
  voice_description: string;
  revised_instruction: string;
  audio_a_url: string;
  audio_b_url: string;
  expires_at: string;
  credits: number;
  miner_hotkey: string;
  model_name: string;
  chute_slug: string;
}

export interface StudioVoiceDesignSaveResponse {
  voice_id: number;
  audio_url: string;
  expires_at: string;
  credits: number;
  ref_script: string;
}

export interface StudioDesignedVoiceItem {
  id: number;
  display_name: string;
  voice_description: string;
  revised_instruction: string;
  chosen_variant: string;
  ref_script: string;
  miner_hotkey: string;
  model_name: string;
  chute_slug: string;
  audio_url: string | null;
  expires_at: string;
  created_at: string;
  expired: boolean;
  // ``source`` tells the UI whether this row came from Voice Design's
  // LLM-driven preview flow ("designed") or from the user uploading a
  // real-voice reference clip and saving it ("cloned"). Defaults to
  // 'designed' for rows that pre-date the column.
  source?: 'designed' | 'cloned';
  source_language?: string | null;
}

export interface StudioClonedVoiceSaveResponse {
  voice_id: number;
  display_name: string;
  ref_script: string;
  source_language: string | null;
  audio_url: string | null;
  expires_at: string;
  credits: number;
}

// ----- Playbooks -----

export interface PlaybookTrack {
  id: number;
  position: number;
  title: string;
  subtitle: string;
  audio_url: string;
  image_url: string | null;
  source_type: string;
  duration_seconds: number | null;
  added_at: string;
}

export interface Playbook {
  id: number;
  title: string;
  description: string;
  cover_image_url: string | null;
  visibility: string;
  track_count: number;
  total_duration: number;
  // Public-playbook play counter. Always 0 for private playbooks.
  play_count: number;
  // Thumb-up vote count (public on all playbooks). ``viewer_voted`` is
  // true only when the request was authenticated and the signed-in user
  // has thumbed this playbook.
  vote_count: number;
  viewer_voted: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlaybookDetail extends Playbook {
  tracks: PlaybookTrack[];
  is_owner: boolean;
}

export interface PublicPlaybook extends Playbook {
  user_name: string;
  user_picture: string | null;
}
