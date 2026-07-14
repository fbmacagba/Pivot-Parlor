import type { MetaFunction } from "@remix-run/cloudflare";
import { Link } from "@remix-run/react";
import { PLATFORM_LEGAL_LAST_UPDATED } from "~/lib/legalDates";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy | Pivot Parlor" },
  {
    name: "description",
    content:
      "How Pivot Parlor collects, uses, and protects your personal data under UK GDPR.",
  },
];

export default function Privacy() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl">
        <h1 className="font-heading text-4xl font-bold text-white">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-white/50">
          Last updated: {PLATFORM_LEGAL_LAST_UPDATED.privacy}
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
              1. Who We Are
            </h2>
            <p className="mt-2">
              Pivot Parlor (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or
              &ldquo;our&rdquo;) is a booking platform for beauty parlours and
              barber shops, operated by BytesFX Ltd, registered in England and
              Wales.
            </p>
            <p className="mt-3">
              We are the <strong>data controller</strong> for the personal data
              we collect to run the platform itself: enquiry and contact
              details, shop-owner and staff account data, and shop business
              data.
            </p>
            <p className="mt-3">
              For <strong>customer booking data</strong> (the personal data of
              people who book appointments with a shop), the shop you book with
              is the data controller and we act as its{" "}
              <strong>data processor</strong>, handling that data only on the
              shop&rsquo;s documented instructions. If you are a booking
              customer wishing to exercise your data rights, please contact the
              shop directly and see that shop&rsquo;s own privacy policy. The
              terms on which we process booking data as a processor are set out
              in our{" "}
              <Link
                to="/dpa"
                className="underline text-white/60 hover:text-white/90"
              >
                Data Processing Agreement
              </Link>
              .
            </p>
            <p className="mt-3">
              We are committed to protecting personal data in accordance with
              the UK General Data Protection Regulation (UK GDPR) and the Data
              Protection Act 2018.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              2. Personal Data We Collect
            </h2>
            <p className="mt-2">
              We collect and process the following categories of personal data:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong>Enquiry and contact data:</strong> your name, email
                address, phone number, shop name, and message when you submit a
                contact or onboarding enquiry.
              </li>
              <li>
                <strong>Account data:</strong> email address and hashed password
                if you register as a shop admin or staff member, or your name
                and email if you sign in via a social provider (Google or
                LinkedIn).
              </li>
              <li>
                <strong>Shop and business data:</strong> your shop name, type,
                address, services, pricing, and staff information provided
                during onboarding and platform use.
              </li>
              <li>
                <strong>Customer booking data:</strong> customer names, email
                addresses, phone numbers, appointment details, and service
                records. For this category the shop is the data controller and
                we process the data on the shop&rsquo;s behalf as its processor.
              </li>
              <li>
                <strong>Payment data:</strong> transaction amounts and booking
                IDs. Full payment card details are processed by Stripe and are
                never stored on our systems.
              </li>
              <li>
                <strong>Technical data:</strong> IP address, browser type and
                version, device type, time zone, and operating system, collected
                automatically when you access our website.
              </li>{" "}
            </ul>
            <p className="mt-3">
              We do not collect sensitive personal data unless you voluntarily
              provide it. We do not knowingly collect data from children under
              16.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              3. How We Use Your Personal Data
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong>To respond to enquiries and onboard new shops</strong> —
                lawful basis: legitimate interests / performance of a contract.
              </li>
              <li>
                <strong>To operate and deliver the platform</strong>, including
                processing bookings, managing staff schedules, and sending
                appointment reminders — lawful basis: performance of a contract.
              </li>
              <li>
                <strong>To process payments and calculate commissions</strong> —
                lawful basis: performance of a contract.
              </li>
              <li>
                <strong>To send service-related communications</strong> such as
                booking confirmations, platform updates, and account
                notifications — lawful basis: performance of a contract /
                legitimate interests.
              </li>{" "}
              <li>
                <strong>To comply with legal obligations</strong> — lawful
                basis: compliance with a legal obligation (Article 6(1)(c) UK
                GDPR).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              4. Who We Share Your Data With
            </h2>
            <p className="mt-2">
              We do not sell your personal data. We may share it with the
              following third parties:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong>Cloudflare, Inc.</strong> - our infrastructure and
                hosting provider (application hosting, storage, and security),
                acting as our processor under its Data Processing Agreement.
                Some data is replicated across Cloudflare&rsquo;s global
                locations, so UK-only or EEA-only residency is not guaranteed.
              </li>
              <li>
                <strong>Stripe</strong> - to process payments securely, via
                Stripe Payments Europe, Ltd and Stripe Payments UK, Ltd, with
                Stripe, LLC in the United States. Stripe acts as our processor
                for payment facilitation and as an independent controller for
                fraud prevention and legal or regulatory compliance. Stripe is
                PCI DSS Level 1 certified and we do not store full card details.
                See{" "}
                <a
                  href="https://stripe.com/gb/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-white/60 hover:text-white/90"
                >
                  Stripe&rsquo;s Privacy Policy
                </a>
                .
              </li>
              <li>
                <strong>Resend (Plus Five Five, Inc.)</strong> - to deliver
                transactional emails such as booking confirmations and
                reminders, acting as our processor. Resend processes email data
                in the United States.
              </li>
              <li>
                <strong>Law enforcement or regulators</strong> - where required
                by law, or to protect our rights, property, or safety.
              </li>
            </ul>
            <p className="mt-3">
              <strong>International transfers.</strong> Some of these providers
              process personal data outside the UK, including in the United
              States. Where that happens we rely on a lawful transfer mechanism
              under UK data protection law, principally the UK International
              Data Transfer Addendum to the EU Standard Contractual Clauses and,
              where applicable, the UK Extension to the EU-U.S. Data Privacy
              Framework. How we process shop customers&rsquo; booking data as a
              processor is set out in our{" "}
              <Link
                to="/dpa"
                className="underline text-white/60 hover:text-white/90"
              >
                Data Processing Agreement
              </Link>
              .
            </p>
            <p className="mt-3">
              Where a provider acts as our processor it must handle your data
              securely and only for the purposes we specify; where a provider
              acts as an independent controller, it does so under its own
              privacy policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              5. Data Retention
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                Enquiry and contact records are retained for up to 2 years.
              </li>
              <li>
                Account and shop data is retained for the duration of the
                shop&rsquo;s active subscription plus 12 months after
                termination.
              </li>
              <li>
                Booking and transaction records are retained for up to 7 years
                to satisfy accounting and legal obligations.
              </li>
              <li>
                Technical and server logs are typically retained for up to 90
                days.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              6. Your Rights Under UK GDPR
            </h2>
            <p className="mt-2">
              You have the following rights in relation to your personal data:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong>Right of access</strong> — to request a copy of the
                personal data we hold about you.
              </li>
              <li>
                <strong>Right to rectification</strong> — to request correction
                of inaccurate or incomplete data.
              </li>
              <li>
                <strong>Right to erasure</strong> — to request deletion of your
                data in certain circumstances.
              </li>
              <li>
                <strong>Right to restrict processing</strong> — to request that
                we limit how we use your data.
              </li>
              <li>
                <strong>Right to data portability</strong> — to receive your
                data in a structured, machine-readable format.
              </li>
              <li>
                <strong>Right to object</strong> — to object to processing based
                on legitimate interests or for direct marketing.
              </li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, contact us at{" "}
              <strong>dev@pivotparlor.com</strong> or write to us at Moselle
              Avenue, London, UK, N22 6ET. We will respond within 30 days. You
              also have the right to lodge a complaint with the{" "}
              <a
                href="https://ico.org.uk"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-white/60 hover:text-white/90"
              >
                Information Commissioner&rsquo;s Office (ICO)
              </a>{" "}
              at ico.org.uk or by calling 0303 123 1113.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              7. Data Security
            </h2>
            <p className="mt-2">
              We implement appropriate technical and organisational measures to
              protect your personal data, including HTTPS/TLS encryption, hashed
              password storage, session token expiry, and access controls
              restricting data to authorised personnel only. In the event of a
              personal data breach likely to result in a risk to your rights and
              freedoms, we will notify the ICO within 72 hours and, where
              required, notify you directly.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">8. Cookies</h2>
            <p className="mt-2">
              Our website uses cookies and similar technologies. See our{" "}
              <Link
                to="/cookies"
                className="underline text-white/60 hover:text-white/90"
              >
                Cookie Policy
              </Link>{" "}
              for full details on what cookies we use, why, and how to manage
              your preferences.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              9. Changes to This Policy
            </h2>
            <p className="mt-2">
              We may update this Privacy Policy from time to time. Any changes
              will be posted on this page with an updated &ldquo;Last
              updated&rdquo; date. We encourage you to review this policy
              periodically.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              10. Contact Us
            </h2>
            <p className="mt-2">
              For any privacy questions or data rights requests, contact us at{" "}
              <strong>dev@pivotparlor.com</strong> or write to Pivot Parlor,
              Moselle Avenue, London, UK, N22 6ET.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}
