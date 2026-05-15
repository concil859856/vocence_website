import { Link } from 'react-router-dom';
import { Github, Send, Twitter } from 'lucide-react';
import { TELEGRAM_INVITE_URL } from '../config/socialLinks';

const SOCIAL_LINKS = [
  { href: 'https://x.com/vocence_bt', label: 'Twitter / X', icon: Twitter },
  { href: 'https://github.com/vocence-78/vocence', label: 'GitHub', icon: Github },
  { href: 'https://discord.gg/TWmfwJAtXG', label: 'Discord', icon: 'discord' as const },
  { href: TELEGRAM_INVITE_URL, label: 'Telegram', icon: Send },
] as const;

function DiscordIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

export function Footer() {
  const footerLinks = {
    features: [
      { label: 'Studio', href: '/studio/home' },
      { label: 'API', href: '/docs/api' },
      { label: 'SDK', href: '/docs/sdk-python' },
      { label: 'Analytics', href: '/dashboard' },
    ] as Array<{ label: string; href?: string; comingSoon?: true }>,
    product: [
      { label: 'Pricing', href: '/pricing' },
      { label: 'Integrations', href: '#' },
      { label: 'Changelog', href: 'https://github.com/vocence-78/vocence/blob/master/CHANGELOG.md' },
      { label: 'Documentation', href: '/docs/getting-started' },
      { label: 'Status', href: '#' },
    ],
    resources: [
      { label: 'Blog', href: '/blog' },
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  };

  return (
    <footer className="border-t border-white/5 bg-[#07080A]">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-16">
        {/* Main Footer Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-12">
          {/* Brand Column */}
          <div className="col-span-2 md:col-span-1">
            <Link to="/" className="flex items-center gap-3 mb-4">
              <img
                src="/vocence_logo3.png"
                alt="Vocence Logo"
                className="h-14 w-auto"
              />
            </Link>
            <p className="text-sm text-[#A7B0B7] mb-6">
              The voice layer for decentralized intelligence.
            </p>
            <div className="flex items-center gap-4">
              {SOCIAL_LINKS.map(({ href, label, icon }) => {
                const IconNode = icon === 'discord' ? <DiscordIcon size={18} /> : (() => { const Icon = icon; return <Icon size={18} />; })();
                return (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={label}
                    className="inline-flex text-[#A7B0B7] hover:text-[#DFFF00] transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0"
                  >
                    {IconNode}
                  </a>
                );
              })}
            </div>
          </div>

          {/* Features */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Features</h4>
            <ul className="space-y-3">
              {footerLinks.features.map((link) => (
                <li key={link.label}>
                  {link.comingSoon ? (
                    <span className="text-sm text-[#A7B0B7] flex items-center gap-2">
                      {link.label}
                      <span className="text-xs text-[#666] font-medium">Coming soon</span>
                    </span>
                  ) : link.href ? (
                    <Link
                      to={link.href}
                      className="text-sm text-[#A7B0B7] hover:text-white transition-colors"
                    >
                      {link.label}
                    </Link>
                  ) : (
                    <span className="text-sm text-[#A7B0B7]">{link.label}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* Product */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Product</h4>
            <ul className="space-y-3">
              {footerLinks.product.map((link) => (
                <li key={link.label}>
                  {'comingSoon' in link && link.comingSoon ? (
                    <span className="text-sm text-[#A7B0B7] flex items-center gap-2">
                      {link.label}
                      <span className="text-xs text-[#666] font-medium">Coming soon</span>
                    </span>
                  ) : (
                    link.href.startsWith('http') ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-[#A7B0B7] hover:text-white transition-colors"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        to={link.href}
                        className="text-sm text-[#A7B0B7] hover:text-white transition-colors"
                      >
                        {link.label}
                      </Link>
                    )
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="text-sm font-semibold mb-4">Resources</h4>
            <ul className="space-y-3">
              {footerLinks.resources.map((link) => (
                <li key={link.label}>
                  <Link
                    to={link.href}
                    className="text-sm text-[#A7B0B7] hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="pt-8 border-t border-white/5 flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-sm text-[#666]">
            © 2026 Vocence. Powered by Bittensor.
          </p>
          <p className="text-xs text-[#666]">
            All rights reserved. Vocence and the Vocence logo are trademarks of Vocence.
          </p>
        </div>
      </div>
    </footer>
  );
}
