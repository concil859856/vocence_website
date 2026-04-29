import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';

interface Props {
  onAccept: () => void;
  onCancel: () => void;
}

export function PlaybookImageConsent({ onAccept, onCancel }: Props) {
  const [checked, setChecked] = useState(false);

  const accept = () => {
    if (!checked) return;
    onAccept();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onCancel}>
      <div
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0f1115] p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#DFFF00]/15 text-[#DFFF00] flex items-center justify-center shrink-0">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Image upload terms</h3>
              <p className="text-xs text-[#A7B0B7] mt-0.5">One-time confirmation before your first upload</p>
            </div>
          </div>
          <button onClick={onCancel} className="text-[#666] hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <ul className="space-y-2 text-sm text-[#C5CAD1] leading-relaxed">
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>I will <span className="text-white font-medium">not upload illegal content</span>, including images depicting minors in sexual or harmful contexts, hate symbols, real violence, or other unlawful material.</span></li>
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>I will <span className="text-white font-medium">not upload NSFW or sexually explicit imagery</span>.</span></li>
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>I have the rights to use this image, or it is my own creation.</span></li>
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>I understand that violating these terms may result in <span className="text-white font-medium">account suspension</span> and removal of the content.</span></li>
        </ul>

        <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 cursor-pointer hover:bg-white/[0.05]">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-[#DFFF00]"
          />
          <span className="text-sm text-white">I agree to the terms above.</span>
        </label>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-xl text-[#A7B0B7] hover:text-white hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={accept}
            disabled={!checked}
            className="px-4 py-2 text-sm rounded-xl bg-[#DFFF00] text-[#07080A] font-semibold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Agree & continue
          </button>
        </div>
      </div>
    </div>
  );
}
