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

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${DASHBOARD_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...options?.headers },
    });
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error(
        `Network error (${e.message}). Request: ${url}. In dev, either leave VITE_API_URL unset (Vite proxies /api) or set it to your backend and add your exact browser origin (localhost vs 127.0.0.1) to backend CORS_ORIGIN.`
      );
    }
    throw e;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dashboard API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
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
  unique_users: number;
  credits_used: number;
  revenue_usd: number;
  credits_purchased: number;
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
    form.append('audio_file', body.audio_file);
    return fetchJson('/api/dashboard/studio/clone', {
      method: 'POST',
      headers,
      body: form,
    });
  },

  getStudioHistory(userId: string): Promise<{ items: StudioHistoryItem[] }> {
    return fetchJson(`/api/dashboard/studio/history?user_id=${encodeURIComponent(userId)}`);
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
      `/api/dashboard/studio/history/${historyId}/audio-url?user_id=${encodeURIComponent(userId)}${et}`
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

  getStudioMusicHistory(userId: string): Promise<{ items: StudioMusicHistoryItem[] }> {
    return fetchJson(`/api/dashboard/studio/music/history?user_id=${encodeURIComponent(userId)}`);
  },

  getStudioMusicHistoryAudioUrl(historyId: number, userId: string): Promise<{ audio_url: string }> {
    return fetchJson(
      `/api/dashboard/studio/music/history/${historyId}/audio-url?user_id=${encodeURIComponent(userId)}`
    );
  },

  // ----- Playbooks -----

  createPlaybook(body: { title?: string; description?: string }, token: string | null): Promise<Playbook> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson('/api/dashboard/playbooks', { method: 'POST', headers, body: JSON.stringify(body) });
  },

  browsePublicPlaybooks(limit = 20): Promise<{ playbooks: PublicPlaybook[] }> {
    return fetchJson(`/api/dashboard/playbooks/public/browse?limit=${limit}`);
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

  updatePlaybook(id: number, body: { title?: string; description?: string; visibility?: string }, token: string | null): Promise<Playbook> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetchJson(`/api/dashboard/playbooks/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
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
