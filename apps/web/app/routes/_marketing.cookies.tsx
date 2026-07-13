import type { MetaFunction } from "@remix-run/cloudflare";
import { Link } from "@remix-run/react";
import { PLATFORM_LEGAL_LAST_UPDATED } from "~/lib/legalDates";

export const meta: MetaFunction = () => [
  { title: "Cookie Policy | Pivot Parlor" },
  { name: "description", content: "How Pivot Parlor uses cookies and how to manage your preferences under UK PECR." },
];

export default function Cookies() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl">
        <h1 className="font-heading text-4xl font-bold text-white">Cookie Policy</h1>
        <p className="mt-2 text-sm text-white/50">Last updated: {PLATFORM_LEGAL_LAST_UPDATED.cookies}</p>

        <div className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/60">
          <span className="font-medium text-white/80">Pivot Parlor</span>
          <br />
          BytesFX Ltd · Moselle Avenue, London, UK, N22 6ET
          <br />
          dev@pivotparlor.com
        </div>

        <div className="mt-10 space-y-8 text-base leading-relaxed text-white/75">

          <section>
            <h2 className="text-lg font-semibold text-white/90">1. What Are Cookies?</h2>
            <p className="mt-2">
              Cookies are small text files placed on your device when you visit a website. They are widely used
              to make websites work efficiently, remember your preferences, and provide information to website
              owners. This Cookie Policy explains how Pivot Parlor uses cookies and similar technologies on
              pivotparlor.com. It should be read alongside our{" "}
              <Link to="/privacy" className="underline text-white/60 hover:text-white/90">Privacy Policy</Link>.
            </p>
            <p className="mt-3">
              Our use of cookies is governed by the UK Privacy and Electronic Communications Regulations (PECR)
              and the UK General Data Protection Regulation (UK GDPR). Non-essential cookies are only set with
              your explicit consent.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">2. Cookies We Use</h2>

            <h3 className="mt-4 font-semibold text-white/80">2.1 Strictly Necessary Cookies</h3>
            <p className="mt-2">
              These cookies are essential for the website and platform to function and cannot be switched off.
              They are set in response to actions you take, such as logging in or setting your cookie preferences.
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
              <li>
                <strong>pp_session</strong> — stores your authenticated session token. Set when you log in.
                Expires after 7 days or on logout. HttpOnly and Secure flags applied.
              </li>
              <li>
                <strong>pp_platform_consent</strong> — stores your cookie consent preferences. Stored in
                localStorage. Persists until you clear your browser data.
              </li>
            </ul>

            <h3 className="mt-6 font-semibold text-white/80">2.2 Analytics Cookies</h3>
            <p className="mt-2">
              These cookies help us understand how visitors interact with our website so we can measure and
              improve its performance. All data collected is aggregated and anonymised. We only set analytics
              cookies where you have given your explicit consent via our cookie preference banner.
            </p>

            <h3 className="mt-6 font-semibold text-white/80">2.3 Marketing Cookies</h3>
            <p className="mt-2">
              Marketing cookies may be used to show relevant content and measure the effectiveness of
              campaigns. We only set marketing cookies where you have given your explicit consent. At present,
              we do not run paid advertising campaigns and marketing cookies are not actively used.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">3. Third-Party Cookies</h2>
            <p className="mt-2">Some cookies are set by third-party services used on our platform:</p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong>Stripe, Inc.</strong> — used to process payments securely. Stripe may set cookies
                related to fraud prevention and payment authentication. See{" "}
                <a href="https://stripe.com/gb/privacy" target="_blank" rel="noopener noreferrer" className="underline text-white/60 hover:text-white/90">
                  Stripe&rsquo;s Privacy Policy
                </a>.
              </li>
              <li>
                <strong>Social login providers</strong> (Google, LinkedIn) — if you use social login,
                these providers may set their own cookies in accordance with their respective privacy policies.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">4. How to Manage Your Preferences</h2>
            <p className="mt-2">
              You can manage non-essential cookies at any time through the cookie preference banner displayed
              at the bottom of this website. You may accept all, reject optional cookies, or customise your
              choices for analytics and marketing separately.
            </p>
            <p className="mt-3">You can also control cookies through your browser settings, which typically allow you to:</p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>View what cookies are stored and delete them individually.</li>
              <li>Block third-party cookies.</li>
              <li>Block cookies from specific sites.</li>
              <li>Delete all cookies when you close your browser.</li>
            </ul>
            <p className="mt-3">
              Please note that disabling all cookies may prevent certain features of the platform from working
              correctly, including login and booking functionality. For guidance on managing cookies, visit{" "}
              <a href="https://www.aboutcookies.org" target="_blank" rel="noopener noreferrer" className="underline text-white/60 hover:text-white/90">aboutcookies.org</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">5. Your Rights</h2>
            <p className="mt-2">
              Under PECR and UK GDPR, you have the right to withdraw your consent to non-essential cookies at
              any time by using the cookie preference banner or clearing your browser cookies. For more
              information about your data rights, see our{" "}
              <Link to="/privacy" className="underline text-white/60 hover:text-white/90">Privacy Policy</Link>.
              You may also lodge a complaint with the{" "}
              <a href="https://ico.org.uk" target="_blank" rel="noopener noreferrer" className="underline text-white/60 hover:text-white/90">
                Information Commissioner&rsquo;s Office (ICO)
              </a>{" "}
              at ico.org.uk or by calling 0303 123 1113.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">6. Changes to This Policy</h2>
            <p className="mt-2">
              We may update this Cookie Policy from time to time to reflect changes in technology, law, or our
              data practices. Updates will be posted on this page with a revised &ldquo;Last updated&rdquo;
              date.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">7. Contact Us</h2>
            <p className="mt-2">
              For any questions about this Cookie Policy, contact us at <strong>dev@pivotparlor.com</strong>{" "}
              or write to Pivot Parlor, Moselle Avenue, London, UK, N22 6ET.
            </p>
          </section>

        </div>
      </article>
    </main>
  );
}
