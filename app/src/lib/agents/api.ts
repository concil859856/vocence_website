/**
 * Agents REST client. Mirrors the dashboard-backend `/api/dashboard/agents`
 * endpoints. All methods require an auth token (callers pass it from
 * AuthContext / localStorage).
 */

import { API_BASE_URL, withNetworkHint } from '../../services/baseUrl';
import { authFetch } from '../../services/authFetch';
import type {
  Agent,
  AgentAnalytics,
  AgentCall,
  AgentConfig,
  AgentDraftRequest,
  AgentDraftResponse,
  AgentRun,
  AgentType,
  AgentWebhook,
  AgentWebhookCreated,
  AnalyticsRange,
  ArchitectChatRequest,
  ArchitectChatResponse,
  WebhookDelivery,
} from './types';

function authHeaders(token: string | null): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(url, init);
  } catch (err) {
    throw withNetworkHint(err);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { /* keep raw */ }
  }
  if (!res.ok) {
    const detail = (body && typeof body === 'object' && 'detail' in body && typeof (body as any).detail === 'string')
      ? (body as any).detail
      : text || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
}

export const agentsApi = {
  async list(token: string): Promise<{ agents: Agent[] }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents`, {
      method: 'GET',
      headers: authHeaders(token),
    });
  },

  async get(token: string, id: string): Promise<{ agent: Agent }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: authHeaders(token),
    });
  },

  async create(token: string, body: { name: string; type: AgentType; config: AgentConfig }): Promise<{ agent: Agent }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  },

  async update(token: string, id: string, body: Partial<{ name: string; status: string; config: Partial<AgentConfig> }>): Promise<{ agent: Agent }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  },

  async remove(token: string, id: string): Promise<{ ok: true }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
  },

  async listCalls(
    token: string,
    id: string,
    opts: { range?: AnalyticsRange; limit?: number } = {},
  ): Promise<{ calls: AgentCall[]; range: AnalyticsRange; limit: number }> {
    const qs = new URLSearchParams();
    if (opts.range) qs.set('range', opts.range);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(id)}/calls${suffix}`,
      { method: 'GET', headers: authHeaders(token) },
    );
  },

  async getAnalytics(
    token: string,
    id: string,
    range: AnalyticsRange = '30d',
  ): Promise<AgentAnalytics> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(id)}/analytics?range=${range}`,
      { method: 'GET', headers: authHeaders(token) },
    );
  },

  /** URL of the audio endpoint — used by the ``<a download>``
   *  link (full-page nav handles redirects + cookies natively).
   *  NOT used by ``<audio src>`` directly: see ``getCallAudioUrl``
   *  for that path. */
  callAudioUrl(_token: string, agentId: string, sessionId: string): string {
    return (
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}` +
      `/calls/${encodeURIComponent(sessionId)}/audio`
    );
  },

  /** Fetch the presigned R2 URL for the in-page audio player. Goes
   *  through our endpoint with cookie auth, then returns the
   *  presigned URL JSON so we can drop it on ``<audio src>``
   *  WITHOUT ``crossOrigin="use-credentials"``. The presigned URL
   *  is its own auth (signed query string); the audio element
   *  loads anonymously from R2, sidestepping the CORS-with-
   *  credentials-and-redirect trap. */
  async getCallAudioUrl(
    token: string,
    agentId: string,
    sessionId: string,
  ): Promise<string> {
    const res = await jsonFetch<{ url: string }>(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/calls/${encodeURIComponent(sessionId)}/audio?json=true`,
      { method: 'GET', headers: authHeaders(token) },
    );
    return res.url;
  },

  async getCallTranscript(
    token: string,
    agentId: string,
    sessionId: string,
  ): Promise<{ session_id: string; agent_id: string; turns: { role: 'user' | 'assistant'; text: string }[] }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/calls/${encodeURIComponent(sessionId)}/transcript`,
      { method: 'GET', headers: authHeaders(token) },
    );
  },

  /** Immediately purge the WAV for one call (owner-only). The
   *  voice_call_logs row is preserved so analytics totals don't
   *  shift retroactively. ``deleted=false`` is fine — means the
   *  recording was already gone. */
  async deleteCallRecording(
    token: string,
    agentId: string,
    sessionId: string,
  ): Promise<{ deleted: boolean }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/calls/${encodeURIComponent(sessionId)}/recording`,
      { method: 'DELETE', headers: authHeaders(token) },
    );
  },

  // ───── Webhooks ──────────────────────────────────────────────────
  async listWebhooks(token: string, agentId: string): Promise<{ webhooks: AgentWebhook[] }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/webhooks`,
      { method: 'GET', headers: authHeaders(token) },
    );
  },

  async createWebhook(
    token: string,
    agentId: string,
    body: { url: string; events?: string[] },
  ): Promise<{ webhook: AgentWebhookCreated }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/webhooks`,
      { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) },
    );
  },

  async deleteWebhook(token: string, agentId: string, webhookId: string): Promise<{ ok: true }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/webhooks/${encodeURIComponent(webhookId)}`,
      { method: 'DELETE', headers: authHeaders(token) },
    );
  },

  async listWebhookDeliveries(
    token: string,
    agentId: string,
    webhookId: string,
    limit = 20,
  ): Promise<{ deliveries: WebhookDelivery[] }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/webhooks/${encodeURIComponent(webhookId)}/deliveries?limit=${limit}`,
      { method: 'GET', headers: authHeaders(token) },
    );
  },

  async testWebhook(token: string, agentId: string, webhookId: string): Promise<{ ok: true }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/webhooks/${encodeURIComponent(webhookId)}/test`,
      { method: 'POST', headers: authHeaders(token) },
    );
  },

  async draft(token: string, body: AgentDraftRequest): Promise<AgentDraftResponse> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/draft`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  },

  async architectChat(
    token: string,
    body: ArchitectChatRequest,
  ): Promise<ArchitectChatResponse> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/architect/chat`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  },

  /**
   * Streaming counterpart to ``architectChat``. POSTs to the
   * ``/architect/chat/stream`` SSE endpoint and yields parsed events
   * as the server emits them:
   *
   *   {type:'token', delta:string}     - prose chunk, append to bubble
   *   {type:'proposed', data:Proposed} - tool call materialized
   *   {type:'done'}                    - terminal, stream complete
   *   {type:'error', message:string}   - terminal, on failure
   *
   * Uses fetch+ReadableStream rather than EventSource so the
   * Authorization header / cookie credentials flow naturally.
   */
  architectChatStream(
    token: string,
    body: ArchitectChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ArchitectStreamEvent, void, unknown> {
    return architectStream(token, body, signal);
  },

  async listRuns(token: string, agentId: string): Promise<{ runs: AgentRun[] }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'GET',
      headers: authHeaders(token),
    });
  },

  async getRun(token: string, agentId: string, runId: string): Promise<{ run: AgentRun }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      { method: 'GET', headers: authHeaders(token) },
    );
  },

  async startRun(token: string, agentId: string): Promise<{ run: AgentRun }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/runs`, {
      method: 'POST',
      headers: authHeaders(token),
    });
  },

  async cancelRun(token: string, agentId: string, runId: string): Promise<{ ok: true }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST', headers: authHeaders(token) },
    );
  },

  /**
   * Available LLM models for the LLMPicker. Uses an existing dashboard
   * endpoint if present; falls back to a single hardcoded entry derived
   * from the backend's default.
   */
  async listModels(token: string): Promise<{ models: { id: string; label: string }[] }> {
    try {
      return await jsonFetch(`${API_BASE_URL}/dashboard/agents/models`, {
        method: 'GET',
        headers: authHeaders(token),
      });
    } catch {
      return { models: [] };
    }
  },

  /** Built-in voice-agent tools catalog. Each entry tells the UI
   *  whether the tool can actually run on this deployment (some
   *  need API keys server-side). Frontend uses this to render the
   *  Tools section of the agent config form. */
  async listBuiltinTools(token: string): Promise<{
    tools: { name: string; description: string; available: boolean; requires_env: string[] }[];
  }> {
    try {
      return await jsonFetch(`${API_BASE_URL}/dashboard/agents/tools/builtin`, {
        method: 'GET',
        headers: authHeaders(token),
      });
    } catch {
      return { tools: [] };
    }
  },
};

export interface BuiltinToolInfo {
  name: string;
  description: string;
  available: boolean;
  requires_env: string[];
}

/* ===========================================================================
   Custom (user-defined) tools
   ===========================================================================

   Per client spec (5/12 chat): "We need to be able to register custom tools."
   These are webhook endpoints the LLM can call mid-conversation. The
   parameters schema is the same JSON Schema shape OpenAI/Groq/Anthropic
   all accept, so a tool registered in Vocence works identically across
   any modern LLM provider.
*/

export type CustomToolMethod = 'POST' | 'GET' | 'PUT' | 'PATCH' | 'DELETE';
export type CustomToolAuthType = 'none' | 'bearer' | 'header';

export interface CustomTool {
  id: string;
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. The LLM uses this to know
   *  what fields to fill in when it decides to call the tool. */
  parameters: Record<string, unknown>;
  endpoint_url: string;
  method: CustomToolMethod;
  auth_type: CustomToolAuthType;
  auth_header_name: string | null;
  /** Whether a secret is set on the server. The actual secret value
   *  is never returned to the client, only the boolean indicator,
   *  so the UI can show "[set]" instead of an empty field on edit. */
  has_secret: boolean;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

export interface CustomToolCreate {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpoint_url: string;
  method?: CustomToolMethod;
  auth_type?: CustomToolAuthType;
  auth_header_name?: string | null;
  /** Plaintext secret on create. Stored server-side; never read back. */
  auth_secret?: string | null;
  timeout_ms?: number;
}

export type CustomToolPatch = Partial<CustomToolCreate>;

export const agentCustomToolsApi = {
  async list(token: string): Promise<{ tools: CustomTool[] }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/tools/custom`, {
      method: 'GET',
      headers: authHeaders(token),
    });
  },

  async create(token: string, body: CustomToolCreate): Promise<{ tool: CustomTool }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/tools/custom`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  },

  async update(token: string, id: string, body: CustomToolPatch): Promise<{ tool: CustomTool }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/tools/custom/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
  },

  async remove(token: string, id: string): Promise<{ ok: true }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/tools/custom/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
  },

  /** Dry-run a tool with sample arguments to verify the endpoint
   *  works before binding to a live agent. Returns the parsed body
   *  the LLM would have seen. */
  async test(token: string, id: string, args: Record<string, unknown>): Promise<{ result: unknown }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/tools/custom/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ arguments: args }),
    });
  },

  async listBoundToAgent(token: string, agentId: string): Promise<{ tools: CustomTool[] }> {
    return jsonFetch(`${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/tools`, {
      method: 'GET',
      headers: authHeaders(token),
    });
  },

  async bind(token: string, agentId: string, toolId: string): Promise<{ ok: true }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(toolId)}`,
      { method: 'POST', headers: authHeaders(token) },
    );
  },

  async unbind(token: string, agentId: string, toolId: string): Promise<{ ok: true }> {
    return jsonFetch(
      `${API_BASE_URL}/dashboard/agents/${encodeURIComponent(agentId)}/tools/${encodeURIComponent(toolId)}`,
      { method: 'DELETE', headers: authHeaders(token) },
    );
  },
};

/* ===========================================================================
   Architect SSE stream consumer
   ===========================================================================

   Reads the ``/architect/chat/stream`` SSE response with fetch+
   ReadableStream and yields parsed events. Backend frames each event as:

     data: <one-line JSON>\n\n

   We accumulate decoded bytes, split on ``\n\n``, parse each block's
   ``data:`` line as JSON, yield it. Abort is honored mid-stream so the
   drawer can cancel an in-flight architect call cleanly. */

export type ArchitectStreamEvent =
  | { type: 'token'; delta: string }
  /** Early signal: the model has committed to calling propose_changes but
   *  arguments are still streaming. Render the Apply button disabled in a
   *  "preparing…" state. The corresponding ``proposed`` event will arrive
   *  later with the full validated payload. */
  | { type: 'proposed_starting' }
  | { type: 'proposed'; data: { name: string; type: AgentType; config: AgentConfig; summary?: string } }
  /** Model emitted a fresh requirements summary via the
   *  ``update_requirements`` tool. Frontend persists this and round-
   *  trips it on subsequent turns. Invisible to the user. */
  | { type: 'requirements'; summary: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

async function* architectStream(
  token: string,
  body: ArchitectChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<ArchitectStreamEvent, void, unknown> {
  let res: Response;
  try {
    res = await authFetch(`${API_BASE_URL}/dashboard/agents/architect/chat/stream`, {
      method: 'POST',
      headers: { ...authHeaders(token), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    yield { type: 'error', message: (err as Error).message || 'network error' };
    return;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    yield { type: 'error', message: text || `HTTP ${res.status}` };
    return;
  }
  if (!res.body) {
    yield { type: 'error', message: 'no response body' };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are double-newline-delimited. Split, keep the
      // trailing partial in ``buf`` for the next iteration.
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // A frame may have multiple lines (event:, id:, etc.). We
        // only care about ``data:`` lines and concatenate them per
        // SSE spec, but the backend only sends one ``data:`` per
        // frame so the common case is a single line.
        const dataLine = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!dataLine) continue;
        try {
          yield JSON.parse(dataLine) as ArchitectStreamEvent;
        } catch {
          // Malformed frame — skip. The backend always emits valid
          // JSON, so this only fires on transport-corruption edge
          // cases. Reporting error here would mask the real one.
        }
      }
    }
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') return;
    yield { type: 'error', message: (err as Error).message || 'stream error' };
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}


export function getStoredToken(): string | null {
  // Cookie-only auth: the session JWT no longer lives in localStorage (it's in
  // the HttpOnly ``vocence_session`` cookie, sent automatically by authFetch's
  // credentials:'include'). Components still gate on this helper with
  // ``if (!token) return``, so return a non-sensitive presence sentinel when a
  // session exists — ``vocence_user`` is set by AuthContext on login/verify and
  // cleared on logout. The sentinel is sent as a Bearer header but the backend
  // ignores it (the cookie takes precedence in require_auth/require_admin_session).
  if (localStorage.getItem('vocence_user')) return 'cookie-session';
  return localStorage.getItem('vocence_token');
}
