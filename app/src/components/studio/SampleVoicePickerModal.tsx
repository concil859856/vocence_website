/**
 * SampleVoicePickerModal — wraps the SampleVoicePicker in a centered modal
 * with a backdrop. Used by the General TTS view: click the voice pill →
 * modal opens → pick a voice → modal closes.
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { SampleVoicePicker } from './SampleVoicePicker';
import type { SampleVoice } from '../../data/sampleVoices';
import type { StudioDesignedVoiceItem } from '../../services/dashboardApi';

interface Props {
  open: boolean;
  selectedId: string | null;
  onSelect: (voice: SampleVoice) => void;
  onClose: () => void;
  /** Forwarded to the picker — when supplied, the user's My Voices are
   * shown as a separate section above the sample voices. */
  designedVoices?: StudioDesignedVoiceItem[];
  onSelectDesigned?: (encodedId: string, item: StudioDesignedVoiceItem) => void;
}

export function SampleVoicePickerModal({
  open,
  selectedId,
  onSelect,
  onClose,
  designedVoices,
  onSelectDesigned,
}: Props) {
  // ESC key + scroll lock while open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-start justify-center bg-black/70 backdrop-blur-sm p-0 sm:pt-[5vh] sm:px-6 sm:pb-6"
      role="dialog"
      aria-modal="true"
      aria-label="Pick a voice"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-2xl max-h-[80vh] sm:max-h-[min(640px,75vh)] bg-[#0B0D10] border border-white/10 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">Choose a voice</h2>
            <p className="text-xs text-[#A7B0B7] mt-0.5">Click ▶ to preview, click the row to select</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-md text-[#A7B0B7] hover:text-white hover:bg-white/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <SampleVoicePicker
            selectedId={selectedId}
            onSelect={(v) => { onSelect(v); onClose(); }}
            designedVoices={designedVoices}
            onSelectDesigned={
              onSelectDesigned
                ? (id, item) => { onSelectDesigned(id, item); onClose(); }
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
