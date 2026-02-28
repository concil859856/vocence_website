import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Twitter, ArrowUp } from 'lucide-react';

const SOCIAL_LINKS = [
  { href: 'https://x.com/vocence_bt', label: 'Twitter / X', icon: Twitter },
] as const;

function scrollToOverviewTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function Footer() {
  const location = useLocation();
  const navigate = useNavigate();

  const handleBackToTop = (e: React.MouseEvent) => {
    e.preventDefault();
    if (location.pathname === '/') {
      scrollToOverviewTop();
    } else {
      navigate('/');
      setTimeout(scrollToOverviewTop, 100);
    }
  };
  const footerLinks = {
    features: [
      { label: 'Studio', href: '/studio' },
      { label: 'API', href: '/docs#api' },
      { label: 'Models', comingSoon: true },
      { label: 'Analytics', href: '/dashboard' },
    ] as Array<{ label: string; href?: string; comingSoon?: true }>,
    product: [
      { label: 'Pricing', comingSoon: true as const },
      { label: 'Integrations', href: '#' },
      { label: 'Changelog', href: '#' },
      { label: 'Documentation', href: '/docs' },
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
              {SOCIAL_LINKS.map(({ href, label, icon: Icon }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="inline-flex text-[#A7B0B7] hover:text-[#DFFF00] transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0"
                >
                  <Icon size={18} />
                </a>
              ))}
              <Link
                to="/"
                onClick={handleBackToTop}
                aria-label="Back to overview top"
                className="inline-flex text-[#A7B0B7] hover:text-[#DFFF00] transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0"
                title="Back to top"
              >
                <ArrowUp size={18} />
              </Link>
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
                    <Link
                      to={link.href}
                      className="text-sm text-[#A7B0B7] hover:text-white transition-colors"
                    >
                      {link.label}
                    </Link>
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
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-white/5">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs font-mono text-[#A7B0B7]">Mainnet</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
