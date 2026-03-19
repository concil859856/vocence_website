/**
 * Dashboard API client — same backend as auth (VITE_API_URL).
 */

const DASHBOARD_BASE =
  import.meta.env.VITE_API_URL != null && import.meta.env.VITE_API_URL !== ''
    ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
    : (import.meta.env.PROD ? '' : 'http://localhost:34717');

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${DASHBOARD_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...options?.headers },
  });
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
}

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
  id: number;
  email: string;
  name: string;
  picture: string | null;
  created_at: string;
  updated_at: string;
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

  getRegisteredUsers(adminEmail: string): Promise<{ users: RegisteredUser[] }> {
    return fetchJson('/api/dashboard/users', {
      headers: { 'X-Admin-Email': adminEmail },
    });
  },

  addValidator(
    data: { uid: number; hotkey: string; stake?: number; s3_bucket?: string },
    adminEmail: string
  ): Promise<DashboardValidator> {
    return fetchJson('/api/dashboard/validators', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Email': adminEmail },
      body: JSON.stringify({
        uid: data.uid,
        hotkey: data.hotkey,
        stake: data.stake ?? 0,
        s3_bucket: data.s3_bucket ?? null,
      }),
    });
  },

  removeValidator(uid: number, adminEmail: string): Promise<{ ok: boolean }> {
    return fetchJson(`/api/dashboard/validators/${uid}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Email': adminEmail },
    });
  },

  getBlocklist(): Promise<{ hotkeys: string[] }> {
    return fetchJson('/api/dashboard/blocklist');
  },

  addBlocklist(hotkey: string, adminEmail: string): Promise<{ hotkeys: string[] }> {
    return fetchJson('/api/dashboard/blocklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Email': adminEmail },
      body: JSON.stringify({ hotkey }),
    });
  },

  removeBlocklist(hotkey: string, adminEmail: string): Promise<{ ok: boolean }> {
    return fetchJson(`/api/dashboard/blocklist/${encodeURIComponent(hotkey)}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Email': adminEmail },
    });
  },

  getBlogPosts(limit = 12, offset = 0): Promise<{ posts: BlogPost[]; total: number }> {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return fetchJson(`/api/dashboard/blog?${params.toString()}`);
  },

  getBlogPost(id: string): Promise<BlogPost> {
    return fetchJson(`/api/dashboard/blog/${id}`);
  },

  uploadBlogImage(file: File, adminEmail: string): Promise<{ url: string }> {
    const form = new FormData();
    form.append('file', file);
    return fetch(`${DASHBOARD_BASE}/api/dashboard/blog/upload`, {
      method: 'POST',
      headers: { 'X-Admin-Email': adminEmail },
      body: form,
    }).then(async (res) => {
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      return res.json();
    });
  },

  createBlogPost(
    data: { title: string; excerpt: string; category: string; read_time?: string; image: string; content: string; featured?: boolean },
    adminEmail: string
  ): Promise<BlogPost> {
    return fetchJson('/api/dashboard/blog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Email': adminEmail },
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
    adminEmail: string
  ): Promise<BlogPost> {
    return fetchJson(`/api/dashboard/blog/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Email': adminEmail },
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

  deleteBlogPost(id: string, adminEmail: string): Promise<{ ok: boolean }> {
    return fetchJson(`/api/dashboard/blog/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Email': adminEmail },
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

  getStudioHistory(userId: string): Promise<{ items: StudioHistoryItem[] }> {
    return fetchJson(`/api/dashboard/studio/history?user_id=${encodeURIComponent(userId)}`);
  },

  getStudioHistoryAudioUrl(historyId: number, userId: string): Promise<{ audio_url: string }> {
    return fetchJson(
      `/api/dashboard/studio/history/${historyId}/audio-url?user_id=${encodeURIComponent(userId)}`
    );
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

export interface StudioHistoryItem {
  id: number;
  miner_hotkey: string;
  model_name: string;
  display_name: string;
  prompt_text: string;
  style_instruction: string;
  audio_url: string | null;
  expires_at: string;
  created_at: string;
  expired: boolean;
}
