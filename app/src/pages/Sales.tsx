import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { TELEGRAM_INVITE_URL } from '../config/socialLinks';

export function Sales() {
  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-16 px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8 flex items-center gap-4">
          <Link
            to="/pricing"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-[#A7B0B7] hover:text-white hover:bg-white/10 transition-colors"
          >
            <ArrowLeft size={16} />
            Back to Pricing
          </Link>
        </div>

        <section className="rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(10,10,10,0.94))] p-8 md:p-10">
          <h1 className="text-3xl md:text-4xl font-semibold text-white">Talk to Sales</h1>
          <p className="mt-3 text-[#A7B0B7]">Choose how you want to contact us.</p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/sales/email"
              className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/10"
            >
              Email
            </Link>
            <a
              href={TELEGRAM_INVITE_URL}
              className="inline-flex items-center justify-center rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20"
            >
              Telegram
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
