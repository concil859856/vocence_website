import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export function Terms() {
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

        <h1 className="text-4xl font-bold mb-2">Terms of Service</h1>
        <p className="text-[#A7B0B7] mb-12">Last updated: February 2025</p>

        <div className="space-y-10 text-[#A7B0B7] leading-7">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using the Vocence website, applications, API, Studio, dashboard, and any related
              services (the &quot;Services&quot;), you agree to be bound by these Terms of Service (&quot;Terms&quot;).
              If you do not agree to these Terms, do not use our Services. We may update these Terms from time
              to time; continued use after changes constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. Description of Service</h2>
            <p>
              Vocence provides a decentralized voice synthesis and voice cloning network built on Bittensor. Our
              Services include text-to-speech generation, voice cloning, API access, Studio tools, dashboards, and
              documentation. We strive to maintain high availability but do not guarantee uninterrupted or
              error-free operation.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. Eligibility and Accounts</h2>
            <p>
              You must be at least 18 years old (or the age of majority in your jurisdiction) and capable of
              forming a binding contract to use our Services. You are responsible for maintaining the
              confidentiality of your account credentials and for all activity under your account. You must
              provide accurate and complete information when creating an account.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. Acceptable Use</h2>
            <p className="mb-3">You agree not to use the Services to:</p>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>Violate any applicable law, regulation, or third-party rights</li>
              <li>Generate content that is illegal, harmful, abusive, defamatory, or infringing</li>
              <li>Impersonate others or use another person&apos;s voice or identity without consent</li>
              <li>Attempt to gain unauthorized access to our systems, networks, or other users&apos; accounts</li>
              <li>Interfere with or disrupt the Services or the underlying Bittensor network</li>
              <li>Scrape, reverse engineer, or build derivative services without permission</li>
            </ul>
            <p className="mt-3">
              We may suspend or terminate access for conduct that we reasonably believe violates these Terms or
              harms the Services or other users.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. Intellectual Property</h2>
            <p>
              The Services, including software, design, text, graphics, and logos, are owned by Vocence or our
              licensors and are protected by intellectual property laws. We grant you a limited, non-exclusive,
              non-transferable license to access and use the Services for their intended purpose. You retain
              ownership of content you submit; you grant us a license to use that content as necessary to provide
              and improve the Services.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. Disclaimers</h2>
            <p>
              THE SERVICES ARE PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND,
              EXPRESS OR IMPLIED. WE DISCLAIM ALL WARRANTIES, INCLUDING MERCHANTABILITY, FITNESS FOR A
              PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICES WILL BE
              UNINTERRUPTED, SECURE, OR ERROR-FREE. USE OF THE SERVICES IS AT YOUR OWN RISK.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. Limitation of Liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, VOCENCE AND ITS AFFILIATES, OFFICERS, AND EMPLOYEES SHALL
              NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOSS
              OF PROFITS, DATA, OR USE, ARISING OUT OF OR IN CONNECTION WITH THESE TERMS OR THE SERVICES. OUR
              TOTAL LIABILITY SHALL NOT EXCEED THE AMOUNT YOU PAID US IN THE TWELVE (12) MONTHS PRECEDING THE
              CLAIM, OR ONE HUNDRED U.S. DOLLARS, WHICHEVER IS GREATER.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">8. Indemnification</h2>
            <p>
              You agree to indemnify and hold harmless Vocence and its affiliates from any claims, damages,
              losses, or expenses (including reasonable attorneys&apos; fees) arising from your use of the Services,
              your content, or your violation of these Terms or any law.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">9. Termination</h2>
            <p>
              We may suspend or terminate your access to the Services at any time for any reason, including
              breach of these Terms. You may stop using the Services at any time. Upon termination, your right
              to use the Services ceases immediately. Provisions that by their nature should survive (including
              disclaimers, limitation of liability, and indemnification) will remain in effect.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">10. Governing Law and Disputes</h2>
            <p>
              These Terms are governed by the laws of the jurisdiction in which Vocence operates, without regard
              to conflict of law principles. Any dispute arising from these Terms or the Services shall be resolved
              through binding arbitration or in the courts of that jurisdiction, as applicable.
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
