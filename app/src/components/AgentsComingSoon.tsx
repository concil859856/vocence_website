import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { StudioShell } from './StudioShell';

export function AgentsComingSoon() {
  return (
    <StudioShell activeView="agents">
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="card-vocence max-w-md w-full p-10 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#DFFF00]/10 border border-[#DFFF00]/30 mb-5">
            <Bot size={22} className="text-[#DFFF00]" />
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#DFFF00]/30 bg-[#DFFF00]/10 text-[#DFFF00] text-xs font-medium tracking-wide mb-5">
            Coming soon
          </div>
          <h2 className="text-2xl font-semibold mb-3">Agents</h2>
          <p className="text-sm text-[#A7B0B7]">
            Build your own voice-chat agents — custom personas, voices, and
            knowledge bases. We're putting the finishing touches on this
            feature. Try Text-to-Speech in the meantime.
          </p>
          <Link to="/studio/tts" className="btn-primary inline-flex mt-6">
            Go to Text-to-Speech
          </Link>
        </div>
      </div>
    </StudioShell>
  );
}
