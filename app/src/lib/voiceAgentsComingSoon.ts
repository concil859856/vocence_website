/**
 * Single source of truth for the "voice agents coming soon" gate.
 *
 * Voice agents (Logos chat + agent-builder create flow) are wired up
 * end-to-end but the launch is pending — until then we keep the UI
 * visible (so people can see what's coming) but short-circuit the
 * actual action with a friendly toast. When we're ready to ship, set
 * ``VOICE_AGENTS_LIVE = true`` here and every call site light up at
 * once.
 *
 * Keeping the gate in one place means we never miss a call site —
 * search the repo for ``blockIfVoiceAgentsComingSoon`` to find every
 * spot we need to remove when we flip the switch.
 */

import { toast } from 'sonner';


/** Set to ``true`` when voice agents are ready for users. While
 *  ``false`` the helper below shows a toast + returns true (= "blocked,
 *  caller should bail"). */
export const VOICE_AGENTS_LIVE = true;


/**
 * If voice agents aren't live yet, show the "coming soon" toast and
 * return ``true`` so the caller can early-return. Returns ``false``
 * (don't block) once we flip the flag.
 *
 * Usage:
 * ```ts
 * const handleCreate = () => {
 *   if (blockIfVoiceAgentsComingSoon()) return;
 *   // real create-agent flow…
 * };
 * ```
 */
export function blockIfVoiceAgentsComingSoon(): boolean {
  if (VOICE_AGENTS_LIVE) return false;
  toast('Voice agents launching soon!', {
    description: "We're putting the final polish on the voice-agent platform. It'll be live very shortly. Thanks for your patience!",
    duration: 5000,
  });
  return true;
}
