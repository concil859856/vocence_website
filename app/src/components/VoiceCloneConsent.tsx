/**
 * Voice-cloning consent modal.
 *
 * Shown EVERY time the user kicks off a clone, not once-and-cached.
 * Voice cloning has real abuse potential (impersonation, deepfake fraud)
 * and a single past acceptance shouldn't stand in for fresh attestation
 * on the next clone, possibly of a different voice. The user must
 * re-affirm the four bullet points each time before the clone proceeds.
 */

import { ShieldCheck, X } from 'lucide-react';

interface Props {
  onAccept: () => void;
  onCancel: () => void;
}

export function VoiceCloneConsent({ onAccept, onCancel }: Props) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onCancel}>
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
              <h3 className="text-base font-semibold text-white">Voice cloning consent</h3>
              <p className="text-xs text-[#A7B0B7] mt-0.5">Confirm before each clone</p>
            </div>
          </div>
          <button onClick={onCancel} className="text-[#666] hover:text-white" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <ul className="space-y-2 text-sm text-[#C5CAD1] leading-relaxed">
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>I have <span className="text-white font-medium">the right to clone this voice</span> (it's mine, or I have the speaker's permission).</span></li>
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>I understand the reference audio is processed by an external voice-cloning provider.</span></li>
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>Generated audio is <span className="text-white font-medium">stored for 7 days</span> on a free plan, or permanently with Premium.</span></li>
          <li className="flex gap-2"><span className="text-[#DFFF00] mt-0.5">•</span><span>I will not use Vocence to impersonate or defraud anyone.</span></li>
        </ul>

        <p className="text-xs text-[#A7B0B7] leading-relaxed">
          By clicking <span className="text-white font-medium">Continue</span> you agree to all of the above.
          If you don't, click <span className="text-white font-medium">Cancel</span> instead.
        </p>

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
            onClick={onAccept}
            className="px-4 py-2 text-sm rounded-xl bg-[#DFFF00] text-[#07080A] font-semibold hover:brightness-110"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
