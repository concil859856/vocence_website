import { useEffect, useState } from 'react';
import { ArrowLeft, CreditCard, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { PricingPlans } from '../components/PricingPlans';
import { useAuth } from '../contexts/AuthContext';
import { api, type NowPaymentsPayCurrencyOptions, type PricingPlan } from '../services/api';
import { formatCreditsCompact } from '../utils/formatCredits';

export function Pricing() {
  const { isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [cryptoOptionsLoading, setCryptoOptionsLoading] = useState<string | null>(null);
  const [cryptoPicker, setCryptoPicker] = useState<{
    planCode: string;
    options: NowPaymentsPayCurrencyOptions;
    selected: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [stripeComingSoon, setStripeComingSoon] = useState(false);

  useEffect(() => {
    api
      .getPricingPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => setPlans([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const checkout = searchParams.get('checkout');
    if (checkout === 'cancel') {
      setMessage('Checkout was canceled. You can review plans and try again any time.');
    }
  }, [searchParams]);

  const normalPlan = plans.find((p) => p.code === 'normal');
  const premiumPlan = plans.find((p) => p.code === 'premium');

  const startStripeCheckout = async (planCode: string) => {
    const token = localStorage.getItem('vocence_token');
    if (!token) {
      setMessage('Please sign in first to continue with plan checkout.');
      return;
    }
    setCheckoutLoading(`stripe:${planCode}`);
    setMessage(null);
    try {
      const res = await api.createCheckoutSession(token, { provider: 'stripe', planCode });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      setMessage(res.message || 'Checkout session created.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create checkout session');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const startCryptoCheckout = async (planCode: string, payCurrency?: string) => {
    const token = localStorage.getItem('vocence_token');
    if (!token) {
      setMessage('Please sign in first to continue with plan checkout.');
      return;
    }
    setCheckoutLoading(`crypto:${planCode}`);
    setMessage(null);
    try {
      const res = await api.createCheckoutSession(token, {
        provider: 'crypto',
        planCode,
        ...(payCurrency ? { payCurrency } : {}),
      });
      if (res.checkoutUrl) {
        if (res.message) {
          setMessage(res.message);
        }
        window.location.href = res.checkoutUrl;
        return;
      }
      setMessage(res.message || 'Crypto checkout session created.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create checkout session');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const openCryptoPicker = async (planCode: string) => {
    const token = localStorage.getItem('vocence_token');
    if (!token) {
      setMessage('Please sign in first to continue with plan checkout.');
      return;
    }
    setCryptoOptionsLoading(planCode);
    setMessage(null);
    try {
      const opt = await api.getNowPaymentsPayCurrencyOptions(planCode);
      if (opt.currencies.length <= 1) {
        const t = opt.currencies[0]?.ticker ?? opt.defaultTicker;
        await startCryptoCheckout(planCode, t);
        return;
      }
      setCryptoPicker({ planCode, options: opt, selected: opt.defaultTicker });
    } catch {
      setMessage('Could not load network list; continuing with your default crypto option.');
      await startCryptoCheckout(planCode, undefined);
    } finally {
      setCryptoOptionsLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-16 px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 flex items-center gap-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-[#A7B0B7] hover:text-white hover:bg-white/10 transition-colors"
          >
            <ArrowLeft size={16} />
            Back
          </Link>
        </div>

        <section className="mb-12 rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(223,255,0,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(125,211,252,0.12),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(10,10,10,0.94))] px-8 py-10 md:px-12 md:py-12">
          <div className="max-w-4xl">
            <span className="label-mono mb-4 block text-[10px] tracking-[0.2em]">Pricing</span>
            <h1 className="text-2xl md:text-3xl font-semibold text-white leading-tight">Vocence Pricing</h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-[#A7B0B7] md:text-base">
              Studio features: <span className="font-medium text-white">Text-to-Speech</span>,{' '}
              <span className="font-medium text-white">Speech-to-Text</span>,{' '}
              <span className="font-medium text-white">Voice Cloning</span>,{' '}
              <span className="font-medium text-white">Voice Design</span>, and{' '}
              <span className="font-medium text-white">Music Generation</span>.{' '}
              Premium users get never-expiring history and unlimited custom voices.
            </p>
            <Link
              to="/docs/pricing"
              className="mt-5 inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:border-white/25 hover:bg-white/10"
            >
              Pricing in Docs
            </Link>

            <div className="mt-8 overflow-hidden rounded-xl border border-white/10">
              <p className="bg-white/[0.04] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#A7B0B7]">
                Pack snapshot
              </p>
              <table className="w-full text-left text-sm">
                <thead className="border-b border-white/10 text-[11px] uppercase tracking-wide text-[#7D8A95]">
                  <tr>
                    <th className="px-4 py-2 font-medium">Plan</th>
                    <th className="px-4 py-2 font-medium">Card</th>
                    <th className="px-4 py-2 font-medium">Crypto</th>
                  </tr>
                </thead>
                <tbody className="text-[#C6CDD4]">
                  <tr className="border-b border-white/5">
                    <td className="px-4 py-2.5 font-medium text-white">Normal</td>
                    <td className="px-4 py-2.5">
                      {normalPlan?.priceUsd != null
                        ? `$${Number.isInteger(normalPlan.priceUsd) ? normalPlan.priceUsd : normalPlan.priceUsd.toFixed(2)} → ${formatCreditsCompact(normalPlan.creditsIncluded)} credits`
                        : `$12 → ${formatCreditsCompact(4000)} credits`}
                    </td>
                    <td className="px-4 py-2.5">
                      {normalPlan?.cryptoPriceUsd != null && normalPlan.cryptoCreditsIncluded != null
                        ? `$${Number.isInteger(normalPlan.cryptoPriceUsd) ? normalPlan.cryptoPriceUsd : normalPlan.cryptoPriceUsd.toFixed(2)} → ${formatCreditsCompact(normalPlan.cryptoCreditsIncluded)} credits`
                        : `$20 → ${formatCreditsCompact(7000)} credits`}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-2.5 font-medium text-white">Premium</td>
                    <td className="px-4 py-2.5">
                      {premiumPlan?.priceUsd != null
                        ? `$${Number.isInteger(premiumPlan.priceUsd) ? premiumPlan.priceUsd : premiumPlan.priceUsd.toFixed(2)} → ${formatCreditsCompact(premiumPlan.creditsIncluded)} credits`
                        : `$24 → ${formatCreditsCompact(10000)} credits`}
                    </td>
                    <td className="px-4 py-2.5">
                      {premiumPlan?.cryptoPriceUsd != null && premiumPlan.cryptoCreditsIncluded != null
                        ? `$${Number.isInteger(premiumPlan.cryptoPriceUsd) ? premiumPlan.cryptoPriceUsd : premiumPlan.cryptoPriceUsd.toFixed(2)} → ${formatCreditsCompact(premiumPlan.cryptoCreditsIncluded)} credits`
                        : `$40 → ${formatCreditsCompact(16000)} credits`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {message ? (
          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-sm text-[#C6CDD4]">
            {message}
          </div>
        ) : null}

        {stripeComingSoon ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stripe-coming-soon-title"
          >
            <div className="relative w-full max-w-sm rounded-[28px] border border-white/10 bg-[#0c0d10] p-8 shadow-[0_0_60px_rgba(0,0,0,0.5)] text-center">
              <button
                type="button"
                onClick={() => setStripeComingSoon(false)}
                className="absolute right-4 top-4 rounded-lg p-1 text-[#A7B0B7] hover:bg-white/10 hover:text-white"
                aria-label="Close"
              >
                <X size={20} />
              </button>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#DFFF00]/10 border border-[#DFFF00]/20">
                <CreditCard size={24} className="text-[#DFFF00]" />
              </div>
              <h2 id="stripe-coming-soon-title" className="text-lg font-semibold text-white">
                Coming Soon
              </h2>
              <p className="mt-2 text-sm text-[#A7B0B7]">
                Stripe card payments are currently under development. Please use crypto checkout in the meantime.
              </p>
              <button
                type="button"
                onClick={() => setStripeComingSoon(false)}
                className="mt-6 w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white hover:bg-white/10"
              >
                Got it
              </button>
            </div>
          </div>
        ) : null}

        {cryptoPicker ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="crypto-picker-title"
          >
            <div className="relative w-full max-w-md rounded-[28px] border border-white/10 bg-[#0c0d10] p-6 shadow-[0_0_60px_rgba(0,0,0,0.5)]">
              <button
                type="button"
                onClick={() => setCryptoPicker(null)}
                className="absolute right-4 top-4 rounded-lg p-1 text-[#A7B0B7] hover:bg-white/10 hover:text-white"
                aria-label="Close"
              >
                <X size={20} />
              </button>
              <h2 id="crypto-picker-title" className="pr-10 text-lg font-semibold text-white">
                Choose how to pay
              </h2>
              <p className="mt-2 text-sm text-[#A7B0B7]">
                Select the asset and network you want to send. The invoice stays in USD; NOWPayments shows the exact
                crypto amount.
              </p>
              <div className="mt-5 space-y-2">
                {cryptoPicker.options.currencies.map((c) => (
                  <label
                    key={c.ticker}
                    className={`flex cursor-pointer gap-3 rounded-2xl border px-4 py-3 transition-colors ${
                      cryptoPicker.selected === c.ticker
                        ? 'border-[#DFFF00]/40 bg-[#DFFF00]/[0.07]'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/20'
                    }`}
                  >
                    <input
                      type="radio"
                      name="payCurrency"
                      className="mt-1"
                      checked={cryptoPicker.selected === c.ticker}
                      onChange={() =>
                        setCryptoPicker((prev) =>
                          prev ? { ...prev, selected: c.ticker } : prev
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-white">{c.label}</span>
                      {c.hint ? (
                        <span className="mt-0.5 block text-xs text-[#7D8A95]">{c.hint}</span>
                      ) : null}
                      <span className="mt-1 block font-mono text-[10px] text-[#5c6670]">{c.ticker}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-6 flex gap-3">
                <button
                  type="button"
                  onClick={() => setCryptoPicker(null)}
                  className="flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const pc = cryptoPicker;
                    if (!pc) return;
                    const sel = pc.selected;
                    setCryptoPicker(null);
                    void startCryptoCheckout(pc.planCode, sel);
                  }}
                  className="flex-1 rounded-2xl bg-[#DFFF00] px-4 py-3 text-sm font-semibold text-[#07080A] hover:opacity-90"
                >
                  Continue to payment
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <PricingPlans
          plans={plans}
          renderActions={(plan) => {
            const planCode = plan.code ?? 'normal';
            if (planCode === 'enterprise') {
              return (
                <Link
                  to="/sales"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                >
                  Talk to Sales
                </Link>
              );
            }
            return (
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setStripeComingSoon(true)}
                  className="inline-flex items-center justify-center rounded-xl bg-[#DFFF00] px-4 py-2.5 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90"
                >
                  Credit Card
                </button>
                <button
                  type="button"
                  onClick={() => openCryptoPicker(planCode)}
                  disabled={
                    checkoutLoading === `crypto:${planCode}` || cryptoOptionsLoading === planCode
                  }
                  className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {checkoutLoading === `crypto:${planCode}` || cryptoOptionsLoading === planCode
                    ? 'Preparing...'
                    : 'Crypto'}
                </button>
              </div>
            );
          }}
        />
        {!isAuthenticated ? (
          <p className="mt-4 text-sm text-[#A7B0B7]">Sign in first to start plan checkout.</p>
        ) : null}
        {loading ? <p className="mt-4 text-sm text-[#A7B0B7]">Loading pricing...</p> : null}

        <section className="mt-12 rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(10,10,10,0.94))] p-6 md:p-8">
          <div className="max-w-none">
            <span className="label-mono mb-3 block text-[10px] tracking-[0.2em]">Developer API</span>
            <h2 className="text-lg md:text-xl font-semibold text-white">Pay-as-you-go for API key users</h2>
            <p className="mt-2 text-xs md:text-sm text-[#A7B0B7]">
              API usage consumes credits from your purchased balance:
              <span className="text-white font-medium"> 2,000 credits per 1M characters</span> (character count = text + instruction prompt). If no instruction is provided, we use
              <span className="text-white font-medium"> &quot;neutral voice&quot;</span>. Developer API access requires a successful
              <span className="text-white font-medium"> Premium</span> purchase.
            </p>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <p className="text-xs uppercase tracking-[0.18em] text-[#7D8A95]">Rate</p>
              <p className="mt-1 text-lg font-semibold text-white">2,000 credits / 1M chars</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <p className="text-xs uppercase tracking-[0.18em] text-[#7D8A95]">Billing</p>
              <p className="mt-1 text-lg font-semibold text-white">Prepaid pay-as-you-go</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <p className="text-xs uppercase tracking-[0.18em] text-[#7D8A95]">Default limit</p>
              <p className="mt-1 text-lg font-semibold text-white">4 req / minute / key</p>
            </div>
          </div>
          <p className="mt-5 text-sm text-[#A7B0B7]">
            Initial API limits are configurable by environment variables and can be raised later as we verify usage patterns.
          </p>
        </section>
      </div>
    </div>
  );
}
