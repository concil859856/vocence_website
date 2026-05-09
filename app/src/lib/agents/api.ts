/**
 * Agents REST client. Mirrors the dashboard-backend `/api/dashboard/agents`
 * endpoints. All methods require an auth token (callers pass it from
 * AuthContext / localStorage).
 */

import { API_BASE_URL, withNetworkHint } from '../../services/baseUrl';
import type {
  Agent,
  AgentConfig,
  AgentDraftRequest,
  AgentDraftResponse,
  AgentRun,
  AgentType,
} from './types';

function authHeaders(token: string | null): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
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
};

export function getStoredToken(): string | null {
  return localStorage.getItem('vocence_token');
}
