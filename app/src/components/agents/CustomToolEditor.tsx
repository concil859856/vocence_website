/**
 * CustomToolEditor — modal for creating / editing a user-defined
 * agent tool. Webhook-style: the user gives us a public-internet URL
 * + JSON Schema for the args, and the voice agent will POST that
 * shape mid-conversation when the LLM decides to invoke the tool.
 *
 * The form is intentionally close to the OpenAI/Groq/Anthropic
 * function-calling shape — name, description, parameters (JSON
 * Schema), plus our own endpoint/auth/timeout fields. Anything you
 * register here works on any modern LLM provider because the schema
 * shape is portable.
 *
 * v1 keeps the parameters field as a raw JSON textarea with
 * validation on save. A guided form-builder (drag-in fields, pick
 * type from a dropdown) is a tasteful future enhancement.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Wrench, X, Beaker, AlertCircle, CheckCircle2, ChevronDown, Check } from 'lucide-react';
import {
  agentCustomToolsApi,
  getStoredToken,
  type CustomTool,
  type CustomToolAuthType,
  type CustomToolCreate,
  type CustomToolMethod,
} from '../../lib/agents/api';

interface Props {
  /** ``null`` = create flow; existing tool = edit flow. */
  initial: CustomTool | null;
  onClose: () => void;
  onSaved: (tool: CustomTool) => void;
}

const METHODS: CustomToolMethod[] = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'];

// Starter JSON Schema — used as the default for new tools so users
// see the shape they're meant to fill in rather than an empty box.
const STARTER_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Example argument. Replace with your tool\'s real inputs.',
    },
  },
  required: ['query'],
};

export function CustomToolEditor({ initial, onClose, onSaved }: Props) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [endpointUrl, setEndpointUrl] = useState(initial?.endpoint_url ?? '');
  const [method, setMethod] = useState<CustomToolMethod>(initial?.method ?? 'POST');
  const [authType, setAuthType] = useState<CustomToolAuthType>(initial?.auth_type ?? 'none');
  const [authHeaderName, setAuthHeaderName] = useState(initial?.auth_header_name ?? '');
  const [authSecret, setAuthSecret] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeout_ms ?? 5000);
  const [parametersJson, setParametersJson] = useState(
    JSON.stringify(initial?.parameters ?? STARTER_SCHEMA, null, 2),
  );
  const [testArgsJson, setTestArgsJson] = useState('{}');
  const [testResult, setTestResult] = useState<unknown | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validate the JSON Schema textarea on every change so the save
  // button can be greyed out cleanly. We don't deep-validate JSON
  // Schema (the backend does on save) — just parseable + an object.
  const parametersOk = (() => {
    try {
      const parsed = JSON.parse(parametersJson);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  })();

  // Name rule mirrors the backend regex (and OpenAI's function-name rule).
  const nameOk = /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  const canSave = nameOk && description.trim() && endpointUrl.trim() && parametersOk && !saving;

  const handleSave = async () => {
    setError(null);
    const token = getStoredToken();
    if (!token) { setError('Sign in to save.'); return; }
    let parameters: Record<string, unknown>;
    try {
      parameters = JSON.parse(parametersJson);
    } catch (e) {
      setError(`Parameters JSON is invalid: ${(e as Error).message}`);
      return;
    }
    const payload: CustomToolCreate = {
      name: name.trim(),
      description: description.trim(),
      parameters,
      endpoint_url: endpointUrl.trim(),
      method,
      auth_type: authType,
      auth_header_name: authType === 'header' ? (authHeaderName.trim() || null) : null,
      timeout_ms: Math.max(1000, Math.min(30000, timeoutMs)),
    };
    // Only send a secret if the user typed one. On edit, leaving the
    // field empty preserves the existing secret server-side.
    if (authType !== 'none' && authSecret.trim()) {
      payload.auth_secret = authSecret;
    }
    setSaving(true);
    try {
      const res = isEdit
        ? await agentCustomToolsApi.update(token, initial!.id, payload)
        : await agentCustomToolsApi.create(token, payload);
      onSaved(res.tool);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTestError(null);
    setTestResult(null);
    const token = getStoredToken();
    if (!token) { setTestError('Sign in to test.'); return; }
    if (!isEdit) {
      setTestError('Save the tool first, then you can test it.');
      return;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(testArgsJson);
    } catch (e) {
      setTestError(`Test arguments aren't valid JSON: ${(e as Error).message}`);
      return;
    }
    setTesting(true);
    try {
      const res = await agentCustomToolsApi.test(token, initial!.id, args);
      setTestResult(res.result);
    } catch (e) {
      setTestError((e as Error).message || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  // Dirty-tracking: was any field changed from its initial value? When
  // editing an existing tool, ``initial`` provides the baseline; when
  // creating, every non-default value is "dirty". The auth_secret field
  // is treated as dirty when it has any value (the user just typed it)
  // because the server-side secret never round-trips to the client.
  const isDirty = (() => {
    const initParams = JSON.stringify(initial?.parameters ?? STARTER_SCHEMA, null, 2);
    return (
      name !== (initial?.name ?? '') ||
      description !== (initial?.description ?? '') ||
      endpointUrl !== (initial?.endpoint_url ?? '') ||
      method !== (initial?.method ?? 'POST') ||
      authType !== (initial?.auth_type ?? 'none') ||
      authHeaderName !== (initial?.auth_header_name ?? '') ||
      authSecret.length > 0 ||
      timeoutMs !== (initial?.timeout_ms ?? 5000) ||
      parametersJson !== initParams
    );
  })();

  // Wrap onClose so any unsaved edit asks for confirmation first. The
  // user was losing work to fat-finger clicks outside the panel and to
  // accidental ESC presses; this is the central guard.
  const requestClose = useCallback(() => {
    if (isDirty) {
      const ok = window.confirm(
        'You have unsaved changes in this tool. Discard them and close?',
      );
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose]);

  // Close on ESC, but route through the dirty-check so an accidental
  // ESC press doesn't wipe a form full of values.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  return (
    // Backdrop click NO LONGER closes the editor — too easy to lose work
    // when reaching for a field outside the panel bounds. Use the X
    // button, Cancel, or ESC (all guarded by `requestClose`).
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div
        className="bg-[#0B0D10] border border-white/15 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-center">
              <Wrench size={16} className="text-[#A7B0B7]" />
            </div>
            <h3 className="text-base font-semibold text-white">
              {isEdit ? `Edit tool — ${initial!.name}` : 'New custom tool'}
            </h3>
          </div>
          <button onClick={requestClose} className="text-[#666] hover:text-white p-1.5 rounded-md hover:bg-white/5">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Identity */}
          <FormField label="Name" hint="LLM function name. Letters, numbers, _, - only. Up to 64 chars.">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="lookup_order"
              className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 font-mono disabled:opacity-60"
            />
            {!nameOk && name && (
              <p className="text-[11px] text-amber-300 mt-1">Must match a–z, A–Z, 0–9, _, - (1–64 chars).</p>
            )}
            {isEdit && (
              <p className="text-[11px] text-[#666] mt-1">Name can't change after creation — re-create the tool if you need a different name.</p>
            )}
          </FormField>

          <FormField label="Description" hint="What this tool does. The LLM reads this to decide when to call it — be concrete.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Look up an order in our internal database by order ID. Use when the user asks about a specific order."
              className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 resize-none"
            />
          </FormField>

          {/* Endpoint */}
          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <FormField label="Endpoint URL" hint="Public HTTPS URL we POST to when the LLM calls this tool.">
              <input
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="https://api.example.com/tools/lookup-order"
                className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 font-mono"
              />
            </FormField>
            <FormField label="Method">
              {/* Fully-custom dropdown so the popup matches the dark
                  theme — native <select> opens an OS-styled menu that
                  can't be CSS-overridden. */}
              <Dropdown
                value={method}
                onChange={(v) => setMethod(v as CustomToolMethod)}
                options={METHODS.map((m) => ({ value: m, label: m }))}
              />
            </FormField>
          </div>

          {/* Auth */}
          <FormField label="Auth" hint="How we authenticate to your endpoint.">
            <div className="space-y-2">
              <Dropdown
                value={authType}
                onChange={(v) => setAuthType(v as CustomToolAuthType)}
                options={[
                  { value: 'none', label: 'No auth' },
                  { value: 'bearer', label: 'Bearer token' },
                  { value: 'header', label: 'Fixed header' },
                ]}
              />
              {authType === 'header' && (
                <input
                  value={authHeaderName ?? ''}
                  onChange={(e) => setAuthHeaderName(e.target.value)}
                  placeholder="X-API-Key"
                  className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 font-mono"
                />
              )}
              {authType !== 'none' && (
                <>
                  <input
                    type="password"
                    value={authSecret}
                    onChange={(e) => setAuthSecret(e.target.value)}
                    placeholder={isEdit && initial?.has_secret ? '[secret set — leave blank to keep]' : authType === 'bearer' ? 'Bearer token value' : 'Header value'}
                    className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 font-mono"
                  />
                  <p className="text-[11px] text-[#666]">Stored server-side; never returned to the browser after save.</p>
                </>
              )}
            </div>
          </FormField>

          {/* Parameters schema */}
          <FormField
            label="Parameters (JSON Schema)"
            hint="Describes the arguments the LLM should fill in. Same shape OpenAI/Groq/Anthropic accept."
          >
            <textarea
              value={parametersJson}
              onChange={(e) => setParametersJson(e.target.value)}
              rows={10}
              className={`w-full bg-[#07080A] border rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none resize-y ${
                parametersOk ? 'border-white/15 focus:border-[#DFFF00]/40' : 'border-red-400/40 focus:border-red-400/60'
              }`}
            />
            {!parametersOk && (
              <p className="text-[11px] text-red-300 mt-1">JSON is invalid — fix before saving.</p>
            )}
          </FormField>

          {/* Timeout */}
          <FormField label="Timeout (ms)" hint={`How long we'll wait for your endpoint to respond. Current: ${timeoutMs} ms.`}>
            <input
              type="range"
              min={1000}
              max={30000}
              step={500}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value))}
              className="w-full accent-[#DFFF00]"
            />
          </FormField>

          {/* Test panel — only useful after the tool is saved */}
          {isEdit && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Beaker size={14} className="text-[#A7B0B7]" />
                <h4 className="text-sm font-semibold text-white">Test the tool</h4>
              </div>
              <p className="text-[12px] text-[#A7B0B7]">
                Fire a sample call with the args below. Same execution path the live voice agent uses,
                so a green result here means the agent can invoke it.
              </p>
              <textarea
                value={testArgsJson}
                onChange={(e) => setTestArgsJson(e.target.value)}
                rows={3}
                placeholder='{"query": "test"}'
                className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-[#DFFF00]/40 resize-y"
              />
              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="inline-flex items-center gap-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.10] text-white px-3 py-2 text-xs font-medium disabled:opacity-40"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Beaker size={12} />}
                Run test
              </button>
              {testError && (
                <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-xs px-3 py-2 flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-px" />
                  <span className="font-mono">{testError}</span>
                </div>
              )}
              {testResult !== null && !testError && (
                <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.05] p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <CheckCircle2 size={12} className="text-emerald-300" />
                    <span className="text-[10px] uppercase tracking-wider text-emerald-300">Result</span>
                  </div>
                  <pre className="text-[11px] text-white font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto">
                    {typeof testResult === 'string' ? testResult : JSON.stringify(testResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-xs px-3 py-2 flex items-start gap-2">
              <AlertCircle size={14} className="shrink-0 mt-px" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 bg-white/[0.02]">
          <button
            onClick={requestClose}
            className="px-3 py-2 rounded-lg border border-white/10 text-sm text-[#A7B0B7] hover:text-white hover:border-white/20 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:brightness-110 disabled:opacity-40 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {isEdit ? 'Save changes' : 'Create tool'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({
  label,
  hint,
  children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-[#666] mt-1">{hint}</p>}
    </div>
  );
}

/**
 * Dark-themed dropdown that replaces the native ``<select>``. Native
 * selects on Chrome / Edge / Firefox open an OS-themed popup (blue
 * highlight, white background, system fonts) that clashes hard with
 * our dark UI — and the popup style can't be overridden via CSS. This
 * is a button + portal-less floating panel that renders inside the
 * modal, so popovers stay on top of the form but disappear cleanly on
 * outside click / ESC. Generic over the option ``value`` string type.
 */
function Dropdown<V extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} className={`relative w-full ${className || ''}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white hover:border-white/25 focus:outline-none focus:border-[#DFFF00]/40 transition-colors"
      >
        <span>{current?.label || value}</span>
        <ChevronDown size={14} className={`text-[#A7B0B7] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-[#0B0D10] shadow-2xl shadow-black/60 py-1"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false); }}
                role="option"
                aria-selected={active}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors ${
                  active
                    ? 'bg-white/[0.08] text-white'
                    : 'text-[#C5CAD1] hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                <span>{opt.label}</span>
                {active && <Check size={14} className="text-[#DFFF00]" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
