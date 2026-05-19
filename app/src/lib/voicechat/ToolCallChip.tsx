/**
 * ToolCallChip — small pill rendered inside an assistant chat bubble
 * when the agent makes a tool call mid-turn. Shows:
 *
 *   • spinner + tool name while the dispatcher is running
 *   • check icon + tool name on success
 *   • alert icon + tool name on error (dispatcher returned {error: ...})
 *
 * Custom (user-defined) tools get the purple identity tint;
 * built-ins get the Vocence lime. The tooltip carries the result
 * preview so a user curious about what came back can hover to see it
 * without us blowing up the chat layout.
 */

import { AlertCircle, CheckCircle2, Loader2, Wrench } from 'lucide-react';
import type { ToolCallStatus } from './useVoiceChat';

export function ToolCallChip({ call }: { call: ToolCallStatus }) {
  const isCustom = call.kind === 'custom';
  const baseTone = isCustom
    ? 'border-purple-400/30 bg-purple-500/10 text-purple-200'
    : 'border-[#DFFF00]/30 bg-[#DFFF00]/10 text-[#DFFF00]';
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono border ${
        call.status === 'error'
          ? 'border-red-400/40 bg-red-500/10 text-red-200'
          : baseTone
      }`}
      title={call.resultPreview || (call.status === 'running' ? 'Running…' : '')}
    >
      {call.status === 'running' ? (
        <Loader2 size={10} className="animate-spin" />
      ) : call.status === 'error' ? (
        <AlertCircle size={10} />
      ) : (
        <CheckCircle2 size={10} />
      )}
      <Wrench size={9} className="opacity-70" />
      <span className="truncate max-w-[180px]">{call.name}</span>
    </span>
  );
}
