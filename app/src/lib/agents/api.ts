/**
 * Agents REST client. Mirrors the dashboard-backend `/api/dashboard/agents`
 * endpoints. All methods require an auth token (callers pass it from
 * AuthContext / localStorage).
 */

import { API_BASE_URL, withNetworkHint } from '../../services/baseUrl';
import { authFetch } from '../../services/authFetch';
import type {
  Agent,
  AgentConfig,
  AgentDraftRequest,
  AgentDraftResponse,
  AgentRun,
  AgentType,
  ArchitectChatRequest,
  ArchitectChatResponse,
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
