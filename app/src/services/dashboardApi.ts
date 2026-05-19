/**
 * Dashboard API client — same backend as auth (VITE_API_URL).
 */
import { API_ORIGIN_BASE } from './baseUrl';

const DASHBOARD_BASE = API_ORIGIN_BASE;

/**
 * Build the Authorization header for admin-only dashboard calls.
 *
 * Admin auth on the backend is gated by `require_admin_session`, which
 * verifies a JWT from `Authorization: Bearer <token>` and checks the decoded
 * email matches `ADMIN_EMAIL`. The token is the same one the website issues
 * after Google OAuth login, stored under `vocence_token` in localStorage.
 */
function adminAuthHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('vocence_token') || '' : '';
  return token ? { Authorization: `Bearer ${token}` } : {};
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
    res = await fetch(url, {
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
    return fetch(`${DASHBOARD_BASE}/api/dashboard/blog/upload`, {
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
    items: Array<{ id: number; type: 'tts' | 'stt' | 'clone' | 'voice_design' | 'music' }>,
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
   * the caller passes inside the /jobs/start payload — keeps the job payload
   * tiny (no base64) so all 6 music tasks behave identically over the wire. */
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
    // Callers should fire-and-forget — the play UI shouldn't wait
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
};

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
  entry_type: 'tts' | 'stt' | 'clone' | 'voice_design' | 'music';
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
