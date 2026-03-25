import type { ReactNode } from 'react';
import { Check, ArrowRight, Coins, Shield, Building2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { PricingPlan } from '../services/api';
import { formatCreditsCompact } from '../utils/formatCredits';

type PricingPlanCard = {
  code?: string;
  name: string;
  badge: string;
  icon: typeof Coins;
  price: string;
  subtitle: string;
  credits: string;
  /** Shown under card price when crypto packs differ from card. */
  cryptoLine?: string;
  highlight?: boolean;
  points: string[];
  cta: string;
  ctaHref: string;
};

const PLANS: PricingPlanCard[] = [
  {
    code: 'normal',
    name: 'Normal',
    badge: 'Starter credits',
    icon: Coins,
    price: '$12',
    subtitle: '4K credits',
    cryptoLine: '$20 · 7K credits',
    credits: '10 credits per TTS generation',
    points: [
      '50 free credits when you register',
      'Can experiment with custom voices you describe',
      'Best for light usage and personal projects',
      'A simple way to explore prompt-controlled voice generation',
    ],
    cta: 'Start with Normal',
    ctaHref: '/account/credits',
  },
  {
    code: 'premium',
    name: 'Premium',
    badge: 'Most popular',
    icon: Shield,
    price: '$24',
    subtitle: '10K credits',
    cryptoLine: '$40 · 16K credits',
    credits: '10 credits per TTS generation',
    highlight: true,
    points: [
      'Best value for heavy Text-to-Speech usage',
      'Larger one-time balance for uninterrupted generation',
      'Ideal for teams, creators, and production workflows',
      'Unlocks Developer API access',
    ],
    cta: 'Buy Premium Pack',
    ctaHref: '/account/credits',
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    badge: 'Custom',
    icon: Building2,
    price: 'Custom',
    subtitle: 'volume pricing',
    credits: 'Private quotas and tailored billing',
    points: [
      'Full API support for product and platform integration',
      'Dedicated onboarding and commercial support',
      'Private quotas and operational flexibility',
      'Built for teams, apps, and larger-scale deployment',
    ],
    cta: 'Talk to Sales',
    ctaHref: 'mailto:hello@vocence.ai?subject=Vocence%20Enterprise',
  },
];

function toCardPlan(plan: PricingPlan): PricingPlanCard {
  const icon = plan.code === 'premium' ? Shield : plan.code === 'enterprise' ? Building2 : Coins;
  const badge = plan.code === 'premium' ? 'Most popular' : plan.code === 'enterprise' ? 'Custom' : 'Starter credits';
  const subtitle =
    plan.priceSubtitle ||
    (plan.billingType === 'subscription' ? 'per month' : `${formatCreditsCompact(plan.creditsIncluded)} credits`);
  const price =
    plan.priceUsd == null ? 'Custom' : `$${Number.isInteger(plan.priceUsd) ? plan.priceUsd.toFixed(0) : plan.priceUsd.toFixed(2)}`;
  let cryptoLine: string | undefined;
  if (
    plan.cryptoPriceUsd != null &&
    plan.cryptoCreditsIncluded != null &&
    (plan.code === 'normal' || plan.code === 'premium')
  ) {
    const p = plan.cryptoPriceUsd;
    const priceStr = Number.isInteger(p) ? p.toFixed(0) : p.toFixed(2);
    cryptoLine = `$${priceStr} · ${formatCreditsCompact(plan.cryptoCreditsIncluded)} credits`;
  }
  return {
    code: plan.code,
    name: plan.name,
    badge,
    icon,
    price,
    subtitle,
    cryptoLine,
    credits:
      plan.code === 'premium'
        ? plan.cryptoCreditsIncluded != null
          ? '10 credits per Studio generation · Premium unlocks Developer API'
          : `${formatCreditsCompact(plan.creditsIncluded)} credits per purchase (API enabled)`
        : plan.code === 'enterprise'
          ? 'Private quotas and tailored billing'
          : '10 credits per TTS generation',
    highlight: plan.highlighted,
    points: plan.features,
    cta: plan.ctaLabel,
    ctaHref: plan.code === 'enterprise' ? 'mailto:hello@vocence.ai?subject=Vocence%20Enterprise' : '/pricing',
  };
}

export function PricingPlans({
  compact = false,
  /** Home overview: taller compact cards, no in-card “card vs crypto” blurb. */
  forOverview = false,
  plans,
  renderActions,
}: {
  compact?: boolean;
  forOverview?: boolean;
  plans?: PricingPlan[];
  renderActions?: (plan: PricingPlan | PricingPlanCard) => ReactNode;
}) {
  const sourcePlans = plans && plans.length > 0 ? plans.map(toCardPlan) : PLANS;
  const sourcePlanMap = plans && plans.length > 0 ? Object.fromEntries(plans.map((plan) => [plan.name, plan])) : {};
  const pinFooterBottom = !compact;
  const overviewCompact = compact && forOverview;

  return (
    <div className="space-y-6">
      <div className={`grid gap-5 ${compact ? 'lg:grid-cols-3' : 'xl:grid-cols-3'}`}>
        {sourcePlans.map((plan) => {
          const Icon = plan.icon;
          const isExternal = plan.ctaHref.startsWith('mailto:');
          const originalPlan = sourcePlanMap[plan.name] ?? plan;
          const dualPriceText =
            plan.cryptoLine && plan.code !== 'enterprise'
              ? overviewCompact
                ? 'text-lg'
                : compact
                  ? 'text-base'
                  : 'text-xl'
              : '';
          const dualCreditsText = overviewCompact ? 'text-xs' : compact ? 'text-[11px]' : 'text-xs';

          return (
            <div key={plan.name} className="h-full min-h-0 min-w-0">
              <div
                className={`relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border ${
                  overviewCompact ? 'min-h-[288px] p-6 md:min-h-[320px] md:p-7' : 'p-5 md:p-6'
                } ${
                  plan.highlight
                    ? 'border-[#DFFF00]/35 bg-[linear-gradient(180deg,rgba(223,255,0,0.10),rgba(10,10,10,0.94))] shadow-[0_0_40px_rgba(223,255,0,0.08)]'
                    : 'border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(10,10,10,0.94))]'
                }`}
              >
              <div className="shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div className={overviewCompact ? 'space-y-3' : 'space-y-2.5'}>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${
                      plan.highlight
                        ? 'bg-[#DFFF00] text-[#07080A]'
                        : 'border border-white/10 bg-white/5 text-[#A7B0B7]'
                    }`}
                  >
                    {plan.badge}
                  </span>
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`flex shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 ${
                        overviewCompact ? 'h-11 w-11' : 'h-10 w-10'
                      }`}
                    >
                      <Icon size={overviewCompact ? 18 : 17} className={plan.highlight ? 'text-[#DFFF00]' : 'text-white'} />
                    </div>
                    <div className="min-w-0">
                      <h3 className={`font-semibold leading-tight text-white ${overviewCompact ? 'text-xl' : 'text-lg'}`}>
                        {plan.name}
                      </h3>
                      <p className={`leading-snug text-[#A7B0B7] ${overviewCompact ? 'text-sm' : 'text-xs'}`}>
                        {plan.credits}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              </div>

              {plan.cryptoLine && plan.code !== 'enterprise' ? (
                <div className={`mt-4 shrink-0 ${overviewCompact ? 'space-y-2.5' : 'space-y-2'}`}>
                  {compact && !forOverview ? (
                    <p className="text-[9px] leading-snug text-[#8B96A0]">
                      <span className="text-[#C6CDD4]">Card vs crypto</span> — different packs.{' '}
                      <Link to="/pricing" className="text-[#DFFF00]/90 underline-offset-2 hover:underline">
                        Pricing
                      </Link>
                    </p>
                  ) : null}
                  {!compact ? (
                    <p className="text-[10px] leading-snug text-[#8B96A0]">
                      Card and crypto are <span className="text-[#C6CDD4]">different packs</span>. Choose at checkout.
                    </p>
                  ) : null}
                  <div
                    className={`flex flex-wrap items-baseline gap-x-2 gap-y-0 rounded-lg border ${
                      overviewCompact ? 'px-3 py-2.5' : 'px-3 py-2'
                    } ${
                      plan.highlight ? 'border-[#DFFF00]/25 bg-[#DFFF00]/[0.06]' : 'border-white/10 bg-white/[0.02]'
                    }`}
                  >
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-[#DFFF00]/90">Stripe</span>
                    <span className={`font-semibold tabular-nums text-white ${dualPriceText || 'text-xl'}`}>
                      {plan.price}
                    </span>
                    <span className={`text-[#A7B0B7] ${dualCreditsText}`}>· {plan.subtitle}</span>
                  </div>
                  <div
                    className={`flex flex-wrap items-baseline gap-x-2 gap-y-0 rounded-lg border border-white/10 bg-white/[0.02] ${
                      overviewCompact ? 'px-3 py-2.5' : 'px-3 py-2'
                    }`}
                  >
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-[#7dd3fc]">Crypto</span>
                    <span className={`font-semibold tabular-nums text-white ${dualPriceText || 'text-xl'}`}>
                      {plan.cryptoLine.split(' · ')[0]}
                    </span>
                    <span className={`text-[#A7B0B7] ${dualCreditsText}`}>
                      ·{' '}
                      {plan.cryptoLine.includes(' · ') ? plan.cryptoLine.split(' · ').slice(1).join(' · ') : ''}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-6 flex shrink-0 items-end gap-2">
                  <span className="text-3xl font-semibold text-white">{plan.price}</span>
                  <span className="pb-0.5 text-xs text-[#A7B0B7]">{plan.subtitle}</span>
                </div>
              )}

              <ul
                className={`${
                  plan.cryptoLine && plan.code !== 'enterprise'
                    ? overviewCompact
                      ? 'mt-6'
                      : 'mt-5'
                    : overviewCompact
                      ? 'mt-7'
                      : 'mt-6'
                } min-h-0 ${overviewCompact ? 'space-y-3' : 'space-y-2.5'} ${pinFooterBottom ? 'flex-1' : ''}`}
              >
                {plan.points.map((point) => (
                  <li
                    key={point}
                    className={`flex items-start gap-2.5 leading-relaxed text-[#C6CDD4] ${
                      overviewCompact ? 'text-sm' : 'text-xs'
                    }`}
                  >
                    <Check
                      size={overviewCompact ? 15 : 14}
                      className={`mt-0.5 shrink-0 ${plan.highlight ? 'text-[#DFFF00]' : 'text-[#7dd3fc]'}`}
                    />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              {!compact && !renderActions && (
                <div className={`shrink-0 ${pinFooterBottom ? 'mt-auto pt-6' : 'mt-6'}`}>
                  {isExternal ? (
                    <a
                      href={plan.ctaHref}
                      className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                        plan.highlight
                          ? 'bg-[#DFFF00] text-[#07080A] hover:opacity-90'
                          : 'border border-white/10 bg-white/5 text-white hover:bg-white/10'
                      }`}
                    >
                      {plan.cta}
                      <ArrowRight size={16} />
                    </a>
                  ) : (
                    <Link
                      to={plan.ctaHref}
                      className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                        plan.highlight
                          ? 'bg-[#DFFF00] text-[#07080A] hover:opacity-90'
                          : 'border border-white/10 bg-white/5 text-white hover:bg-white/10'
                      }`}
                    >
                      {plan.cta}
                      <ArrowRight size={16} />
                    </Link>
                  )}
                </div>
              )}
              {!compact && renderActions ? (
                <div className={`shrink-0 ${pinFooterBottom ? 'mt-auto pt-6' : 'mt-6'}`}>
                  {renderActions(originalPlan)}
                </div>
              ) : null}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
