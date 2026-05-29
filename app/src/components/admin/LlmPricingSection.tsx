/**
 * LLM Pricing — admin-editable price table.
 *
 * Each row is (provider, model) → input_per_1m + output_per_1m USD.
 * The backend reads this table when computing ``cost_usd`` on every
 * ``llm_calls`` row, so edits propagate to all future cost charts.
 *
 * Gating: like the other Ops admin pages, the underlying endpoints
 * require admin sudo-unlock. We rely on the same JWT in localStorage
 * + X-Admin-Token in sessionStorage that ``opsApi`` already sends.
 *
 * Lives on /admin (Admin.tsx) — not /admin/ops — so the admin can edit
 * pricing without leaving the catalogue / ops surfaces unintentionally.
 */

import { useCallback, useEffect, useState } from 'react';
import { Coins, Pencil, Plus, Trash2 } from 'lucide-react';
import { opsApi } from '../../lib/ops/api';
import { getStoredToken } from '../../lib/agents/api';
import type { LlmPricingRow } from '../../lib/ops/types';

const ACCENT = '#D1F840';


export function LlmPricingSection() {
  const [rows, setRows] = useState<LlmPricingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<LlmPricingRow | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    const token = getStoredToken() || '';
    try {
      const r = await opsApi.llmPricingList(token);
      setRows(r.rows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleSave = async (row: Omit<LlmPricingRow, 'updated_at'>, isNew: boolean) => {
    const token = getStoredToken() || '';
    try {
      await opsApi.llmPricingUpsert(token, row);
      setEditing(null);
      if (isNew) setShowNew(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDeactivate = async (row: LlmPricingRow) => {
    if (!window.confirm(`Deactivate pricing for ${row.provider}/${row.model}? Existing llm_calls rows keep their cost, but future calls will show NULL cost until you re-add it.`)) {
      return;
    }
    const token = getStoredToken() || '';
    try {
      await opsApi.llmPricingDeactivate(token, row.provider, row.model);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const visibleRows = showInactive ? rows : rows.filter((r) => r.active === 1);

  return (
    <section className="glass-panel rounded-xl p-6 mb-8">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Coins className="w-5 h-5" style={{ color: ACCENT }} />
          LLM pricing
        </h2>
        <div className="flex items-center gap-3">
          <label className="text-xs text-[#A7B0B7] inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="w-3.5 h-3.5 accent-[#DFFF00] rounded"
            />
            Show inactive
          </label>
          <button
            type="button"
            onClick={() => { setShowNew(true); setEditing(null); }}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-[#07080A] hover:opacity-90"
            style={{ background: ACCENT }}
          >
            <Plus size={14} /> New
          </button>
        </div>
      </div>

      <p className="text-xs text-[#A7B0B7] mb-3 leading-relaxed">
        Rates are USD per 1 million tokens. Edits take effect on the next
        LLM call — cached prices refresh every 60 seconds, so the cost
        column in the LLM tab will update shortly after a change. Existing
        ``llm_calls`` rows keep the cost they were tagged with at write
        time, so historical totals stay correct.
      </p>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {loading ? (
        <p className="text-sm text-[#A7B0B7]">Loading…</p>
      ) : (
        <div className="border border-[#27272a] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#0f0f0f] text-[10px] uppercase tracking-wider text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">Provider</th>
                <th className="text-left px-3 py-2">Model</th>
                <th className="text-right px-3 py-2">$/1M input</th>
                <th className="text-right px-3 py-2">$/1M output</th>
                <th className="text-left px-3 py-2">Notes</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#27272a]">
              {visibleRows.map((r) => (
                <tr
                  key={`${r.provider}-${r.model}`}
                  className={`hover:bg-[#1a1a1a] ${r.active === 0 ? 'opacity-50' : ''}`}
                >
                  <td className="px-3 py-2 text-white font-mono text-xs">{r.provider}</td>
                  <td className="px-3 py-2 text-white font-mono text-xs">{r.model}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-white">${r.input_per_1m.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-white">${r.output_per_1m.toFixed(2)}</td>
                  <td className="px-3 py-2 text-[#A7B0B7] text-xs truncate max-w-[280px]" title={r.notes ?? undefined}>
                    {r.notes ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => { setEditing(r); setShowNew(false); }}
                        className="p-1.5 text-[#A7B0B7] hover:text-white hover:bg-white/[0.05] rounded"
                        title="Edit"
                      >
                        <Pencil size={13} />
                      </button>
                      {r.active === 1 && (
                        <button
                          type="button"
                          onClick={() => void handleDeactivate(r)}
                          className="p-1.5 text-red-300 hover:text-red-200 hover:bg-red-500/[0.06] rounded"
                          title="Deactivate"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-sm text-[#A7B0B7]">
                    No pricing rows. Click <span className="text-[#DFFF00]">+ New</span> to add one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(editing || showNew) && (
        <PricingEditor
          initial={editing ?? undefined}
          isNew={showNew}
          onCancel={() => { setEditing(null); setShowNew(false); }}
          onSave={(row) => handleSave(row, showNew)}
        />
      )}
    </section>
  );
}


function PricingEditor({
  initial,
  isNew,
  onCancel,
  onSave,
}: {
  initial?: LlmPricingRow;
  isNew: boolean;
  onCancel: () => void;
  onSave: (row: Omit<LlmPricingRow, 'updated_at'>) => Promise<void> | void;
}) {
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [inputPer1m, setInputPer1m] = useState(String(initial?.input_per_1m ?? '0'));
  const [outputPer1m, setOutputPer1m] = useState(String(initial?.output_per_1m ?? '0'));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [active, setActive] = useState<boolean>((initial?.active ?? 1) === 1);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const submit = async () => {
    if (!provider.trim() || !model.trim()) {
      setEditorError('Provider and model are required.');
      return;
    }
    const inP = Number(inputPer1m);
    const outP = Number(outputPer1m);
    if (!Number.isFinite(inP) || inP < 0 || !Number.isFinite(outP) || outP < 0) {
      setEditorError('Prices must be non-negative numbers.');
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      await onSave({
        provider: provider.trim(),
        model: model.trim(),
        input_per_1m: inP,
        output_per_1m: outP,
        notes: notes.trim() || null,
        active: active ? 1 : 0,
      });
    } catch (e) {
      setEditorError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d0e10] border border-white/15 rounded-2xl max-w-lg w-full p-5 space-y-3">
        <h3 className="text-white font-semibold">
          {isNew ? 'New pricing row' : `Edit ${initial?.provider}/${initial?.model}`}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">Provider</div>
            <input
              type="text"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              disabled={!isNew}
              placeholder="cerebras"
              className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/30 disabled:opacity-50"
            />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">Model</div>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!isNew}
              placeholder="gpt-oss-120b"
              className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/30 disabled:opacity-50"
            />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">$ per 1M input</div>
            <input
              type="number"
              step="0.0001"
              min={0}
              value={inputPer1m}
              onChange={(e) => setInputPer1m(e.target.value)}
              className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/30"
            />
          </label>
          <label className="block">
            <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">$ per 1M output</div>
            <input
              type="number"
              step="0.0001"
              min={0}
              value={outputPer1m}
              onChange={(e) => setOutputPer1m(e.target.value)}
              className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/30"
            />
          </label>
        </div>
        <label className="block">
          <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1">Notes</div>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="verified 2026-05-29 against public rate card"
            className="w-full bg-[#0f0f0f] border border-[#27272a] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-white/30"
          />
        </label>
        <label className="text-xs text-[#A7B0B7] inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="w-3.5 h-3.5 accent-[#DFFF00] rounded"
          />
          Active (used for cost calculation)
        </label>
        {editorError && <p className="text-sm text-red-300">{editorError}</p>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="text-sm text-[#A7B0B7] hover:text-white px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#DFFF00] text-[#07080A] px-3.5 py-1.5 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
