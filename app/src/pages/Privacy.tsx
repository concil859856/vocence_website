import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export function Privacy() {
  const navigate = useNavigate();
  const backToHome = () => navigate('/');

  return (
    <div className="min-h-screen bg-[#07080A] pt-24">
      <div className="max-w-3xl mx-auto px-6 lg:px-8 py-16">
        <button
          type="button"
          onClick={backToHome}
          className="inline-flex items-center gap-2 text-sm text-[#A7B0B7] hover:text-[#DFFF00] transition-colors mb-8 bg-transparent border-0 cursor-pointer p-0 font-inherit"
        >
          <ArrowLeft size={16} />
          Back to home
        </button>

        <h1 className="text-4xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-[#A7B0B7] mb-12">Last updated: February 2025</p>

        <div className="space-y-10 text-[#A7B0B7] leading-7">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Introduction</h2>
            <p>
              Vocence (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) is committed to protecting your privacy.
              This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you
              use our website, applications, API, and related services (the &quot;Services&quot;). Please read this
              policy carefully. By using our Services, you consent to the practices described herein.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Information We Collect</h2>
            <p className="mb-3">We may collect information that you provide directly to us, including:</p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>Account information (e.g., email address, username, password)</li>
              <li>Profile and usage data when you use our Studio, API, or dashboard</li>
              <li>Audio content you submit for synthesis or voice cloning (processed according to our technical and security practices)</li>
              <li>Communications with us (support requests, feedback)</li>
            </ul>
            <p className="mt-3">
              We may also automatically collect certain technical information, such as IP address, browser type,
              device information, and usage data (e.g., pages visited, features used) to improve our Services and
              security.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. How We Use Your Information</h2>
            <p>We use the information we collect to:</p>
            <ul className="list-disc list-inside space-y-2 ml-2 mt-2">
              <li>Provide, maintain, and improve our Services</li>
              <li>Process transactions and send related information</li>
              <li>Send technical notices, updates, and support messages</li>
              <li>Respond to your comments and questions</li>
              <li>Monitor and analyze trends, usage, and security</li>
              <li>Comply with legal obligations and enforce our terms</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Sharing and Disclosure</h2>
            <p>
              We do not sell your personal information. We may share your information with service providers who
              assist our operations (e.g., hosting, analytics), with your consent, or when required by law. In the
              context of our decentralized network, certain technical data may be processed by miners and
              validators in accordance with our protocol design and agreements.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Data Security</h2>
            <p>
              We implement appropriate technical and organizational measures to protect your data against
              unauthorized access, alteration, disclosure, or destruction. No method of transmission over the
              internet or electronic storage is 100% secure; we strive to use industry-standard practices to
              safeguard your information.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Your Rights</h2>
            <p>
              Depending on your location, you may have rights to access, correct, delete, or port your personal
              data, or to object to or restrict certain processing. You may also have the right to withdraw
              consent or lodge a complaint with a supervisory authority. To exercise these rights, contact us
              using the details below.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Cookies and Tracking</h2>
            <p>
              We may use cookies and similar technologies to operate our website, remember preferences, and
              analyze usage. You can control cookie settings through your browser; some features may not function
              fully if cookies are disabled.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will post the revised policy on this page
              and update the &quot;Last updated&quot; date. Continued use of the Services after changes constitutes
              acceptance of the updated policy.
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-white/10">
          <button
            type="button"
            onClick={backToHome}
            className="inline-flex items-center gap-2 text-sm text-[#A7B0B7] hover:text-[#DFFF00] transition-colors bg-transparent border-0 cursor-pointer p-0 font-inherit"
          >
            <ArrowLeft size={16} />
            Back to home
          </button>
        </div>
      </div>
    </div>
  );
}
