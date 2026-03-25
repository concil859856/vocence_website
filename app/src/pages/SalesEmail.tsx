import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

export function SalesEmail() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      const response = await api.sendSalesInquiry({ name, email, company, message });
      setStatus(response.message || 'Your message has been sent to space@vocence.ai.');
      setName('');
      setEmail('');
      setCompany('');
      setMessage('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to send your message.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-16 px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8 flex items-center gap-4">
          <Link
            to="/sales"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-[#A7B0B7] hover:text-white hover:bg-white/10 transition-colors"
          >
            <ArrowLeft size={16} />
            Back to options
          </Link>
        </div>

        <section className="rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(10,10,10,0.94))] p-8 md:p-10">
          <h1 className="text-3xl md:text-4xl font-semibold text-white">Talk to Sales by Email</h1>
          <p className="mt-3 text-[#A7B0B7]">
            Tell us what you need and we will email back from <span className="text-white">space@vocence.ai</span>.
          </p>

          <form className="mt-8 space-y-4" onSubmit={onSubmit}>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-[#7D8690] outline-none focus:border-[#DFFF00]/60"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Work email"
              required
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-[#7D8690] outline-none focus:border-[#DFFF00]/60"
            />
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Company (optional)"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-[#7D8690] outline-none focus:border-[#DFFF00]/60"
            />
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What do you want to build with Vocence?"
              required
              rows={6}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-[#7D8690] outline-none focus:border-[#DFFF00]/60"
            />
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center rounded-xl bg-[#DFFF00] px-6 py-3 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Sending...' : 'Send to Sales'}
            </button>
          </form>

          {status ? (
            <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-[#C6CDD4]">{status}</div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
