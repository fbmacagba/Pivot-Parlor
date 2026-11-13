import type { MetaFunction } from "@remix-run/cloudflare";
import { PLATFORM_LEGAL_LAST_UPDATED } from "~/lib/legalDates";

export const meta: MetaFunction = () => [
  { title: "Terms of Service | Pivot Parlor" },
  {
    name: "description",
    content:
      "Terms of Service for Pivot Parlor, the booking platform for beauty parlours and barber shops.",
  },
];

export default function Terms() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl">
        <h1 className="font-heading text-4xl font-bold text-white">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-white/50">
          Last updated: {PLATFORM_LEGAL_LAST_UPDATED.terms}
        </p>

        <div className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/60">
          <span className="font-medium text-white/80">Pivot Parlor</span>
          <br />
          BytesFX Ltd · Moselle Avenue, London, UK, N22 6ET
          <br />
          dev@pivotparlor.com
        </div>

        <div className="mt-10 space-y-8 text-base leading-relaxed text-white/75">
          <section>
            <h2 className="text-lg font-semibold text-white/90">
              1. About Us and These Terms
            </h2>
            <p className="mt-2">
              These Terms of Service (&ldquo;Terms&rdquo;) govern your access to
              and use of the Pivot Parlor platform (&ldquo;Platform&rdquo;),
              operated by BytesFX Ltd (&ldquo;Pivot Parlor&rdquo;,
              &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;),
              registered in England and Wales, with offices at Moselle Avenue,
              London, UK, N22 6ET.
            </p>
            <p className="mt-3">
              By accessing our website or registering a shop on the Platform,
              you confirm that you have read, understood, and agree to be bound
              by these Terms. If you do not agree, please do not use the
              Platform.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              2. The Platform
            </h2>
            <p className="mt-2">
              Pivot Parlor provides a multi-tenant online booking and scheduling
              platform for beauty parlours and barber shops
              (&ldquo;Shops&rdquo;). Our services include: AI-generated branded
              booking pages, staff and schedule management, customer booking and
              waitlist management, appointment reminders, and payment processing
              via Stripe Connect.
            </p>
            <p className="mt-3">
              We act as a technology provider and payment facilitator. Each Shop
              is an independent business responsible for the services they offer
              to their customers.
            </p>
            <p className="mt-3">
              For the personal data of your booking customers, you are the data
              controller and we act as your data processor. That processing is
              governed by our{" "}
              <a
                href="/dpa"
                className="text-gold underline decoration-gold/50 hover:decoration-gold"
              >
                Data Processing Agreement
              </a>
              , which forms part of these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              3. Onboarding and Eligibility
            </h2>
            <p className="mt-2">
              Access to the Platform is by invitation only. To register a Shop,
              you must be invited by a Pivot Parlor developer, pay a one-time
              setup fee of £100 (covering onboarding, training, and AI site
              generation), and complete Stripe Connect onboarding to receive
              payments.
            </p>
            <p className="mt-3">
              You must be at least 18 years old and have the legal authority to
              operate your Shop and enter into these Terms. By registering, you
              represent and warrant that all information you provide is accurate
              and complete.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              4. Commission and Payments
            </h2>
            <p className="mt-2">
              We charge a commission of 10% on the value of each completed
              booking processed through the Platform. Commission is calculated
              automatically at the time of payment and deducted via Stripe
              Connect before funds are transferred to your Shop account.
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                Cancelled bookings and no-shows are not charged commission.
              </li>
              <li>
                The one-time setup fee of £100 is non-refundable once onboarding
                has commenced.
              </li>
              <li>
                Prices displayed to customers are set by the Shop and are
                inclusive of VAT where applicable.
              </li>
              <li>
                We reserve the right to adjust our commission rate with 30
                days&rsquo; written notice.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              5. Your Obligations as a Shop Owner
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                Keep your shop information, services, staff, and pricing
                accurate and up to date.
              </li>
              <li>
                Complete Stripe Connect onboarding and maintain a valid
                connected payment account.
              </li>
              <li>
                Comply with all applicable laws and regulations, including
                consumer protection, employment, and data protection law.
              </li>
              <li>
                Honour confirmed bookings and handle cancellations fairly and
                transparently with customers.
              </li>
              <li>
                Not use the Platform for any unlawful, fraudulent, or misleading
                purpose.
              </li>
              <li>
                Keep your login credentials secure and notify us immediately of
                any unauthorised access.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              6. Intellectual Property
            </h2>
            <p className="mt-2">
              The Pivot Parlor platform, software, design, and infrastructure
              are owned by BytesFX Ltd and protected by applicable intellectual
              property laws. AI-generated brand content (copy, colour palettes,
              imagery prompts) produced for your Shop is licensed to you for use
              on the Platform. You retain ownership of your own business
              information and customer data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              7. Suspension and Termination
            </h2>
            <p className="mt-2">
              Either party may terminate these Terms with 30 days&rsquo; written
              notice. We may suspend or terminate your access immediately if we
              reasonably believe you have materially breached these Terms,
              engaged in fraudulent activity, or pose a risk to the Platform or
              other users.
            </p>
            <p className="mt-3">
              Upon termination, pending confirmed bookings will be fulfilled.
              Your shop data will be retained for the period set out in our
              Privacy Policy, after which it will be deleted.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              8. Limitation of Liability
            </h2>
            <p className="mt-2">
              To the fullest extent permitted by applicable law, Pivot Parlor
              shall not be liable for any indirect, incidental, special,
              consequential, or punitive damages. Our total liability to you
              shall not exceed the commission paid by you in the three months
              preceding the event giving rise to the claim.
            </p>
            <p className="mt-3">
              Nothing in these Terms excludes or limits our liability for death
              or personal injury caused by our negligence, fraud or fraudulent
              misrepresentation, or any other liability that cannot be excluded
              or limited under English law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              9. Consumer Rights
            </h2>
            <p className="mt-2">
              If you are a consumer using our platform for personal,
              non-business purposes, nothing in these Terms affects your
              statutory rights under the Consumer Rights Act 2015 or any other
              applicable UK consumer protection legislation.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              10. Governing Law and Disputes
            </h2>
            <p className="mt-2">
              These Terms are governed by the laws of England and Wales. Any
              disputes arising in connection with these Terms shall be subject
              to the exclusive jurisdiction of the courts of England and Wales.
              We are committed to resolving disputes fairly. Please contact us
              at dev@pivotparlor.com before commencing any legal proceedings.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              11. Changes to These Terms
            </h2>
            <p className="mt-2">
              We may update these Terms from time to time. Material changes will
              be communicated to registered Shop owners by email with at least
              14 days&rsquo; notice. Your continued use of the Platform after
              the effective date constitutes acceptance of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              12. Contact Us
            </h2>
            <p className="mt-2">
              For any questions about these Terms, contact us at{" "}
              <strong>dev@pivotparlor.com</strong> or write to Pivot Parlor,
              Moselle Avenue, London, UK, N22 6ET.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
