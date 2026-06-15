import type { MetaFunction } from "@remix-run/cloudflare";
import { Link } from "@remix-run/react";

export const meta: MetaFunction = () => [
  { title: "Data Processing Agreement | Pivot Parlor" },
  {
    name: "description",
    content:
      "The Article 28 UK GDPR Data Processing Agreement between Pivot Parlor (BytesFX Ltd) and shops using the platform.",
  },
];

export default function DataProcessingAgreement() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl">
        <h1 className="font-heading text-4xl font-bold text-white">Data Processing Agreement</h1>
        <p className="mt-2 text-sm text-white/50">Last updated: March 2026</p>

        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90">
          <strong className="font-medium">Template pending legal review.</strong> This agreement is a working
          draft provided for convenience. It should be reviewed and approved by qualified legal counsel before
          being relied upon. It does not yet constitute legal advice.
        </div>

        <div className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/60">
          <span className="font-medium text-white/80">Processor / Platform Provider</span>
          <br />
          BytesFX Ltd (trading as Pivot Parlor) · Moselle Avenue, London, UK, N22 6ET
          <br />
          dev@pivotparlor.com
        </div>

        <div className="mt-10 space-y-8 text-base leading-relaxed text-white/75">

          <section>
            <h2 className="text-lg font-semibold text-white/90">1. Parties and Roles</h2>
            <p className="mt-2">
              This Data Processing Agreement (&ldquo;DPA&rdquo;) forms part of the agreement between the shop using
              the Pivot Parlor platform (the &ldquo;Shop&rdquo;) and BytesFX Ltd, trading as Pivot Parlor
              (&ldquo;Pivot Parlor&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), and governs the processing of personal
              data under the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018.
            </p>
            <p className="mt-2">
              For customer booking data, the Shop and Pivot Parlor act as <strong>joint controllers</strong> in
              respect of the purposes each determines. In addition, where Pivot Parlor processes personal data
              solely on the Shop&rsquo;s documented instructions to operate the booking service, Pivot Parlor acts
              as the Shop&rsquo;s <strong>processor</strong>, and the terms of this DPA (Articles 28 UK GDPR) apply
              to that processing.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">2. Subject Matter and Duration</h2>
            <p className="mt-2">
              The subject matter is the processing of personal data necessary to provide the Pivot Parlor booking
              platform to the Shop. Processing continues for the duration of the Shop&rsquo;s use of the platform
              and ceases on termination, subject to the deletion/return provisions in Section 8.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">3. Nature and Purpose of Processing</h2>
            <p className="mt-2">
              Hosting, storing, and processing booking and account data to enable appointment booking, scheduling,
              reminders, payment facilitation, commission calculation, and related platform operations.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">4. Categories of Data and Data Subjects</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li><strong>Data subjects:</strong> the Shop&rsquo;s customers, staff, and authorised users.</li>
              <li><strong>Personal data:</strong> names, email addresses, phone numbers, appointment details,
                service records, and transaction metadata. No special-category data is intentionally processed.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">5. Pivot Parlor&rsquo;s Obligations (Article 28(3))</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>Process personal data only on the Shop&rsquo;s documented instructions, including this DPA, unless required by law.</li>
              <li>Ensure persons authorised to process the data are bound by confidentiality.</li>
              <li>Implement appropriate technical and organisational security measures (Article 32) — see Section 7.</li>
              <li>Engage sub-processors only as set out in Section 6, under equivalent data-protection obligations.</li>
              <li>Assist the Shop, taking into account the nature of processing, in responding to data-subject rights requests.</li>
              <li>Assist the Shop with security, breach notification, and data-protection impact assessments.</li>
              <li>Delete or return personal data at the end of the service, per Section 8.</li>
              <li>Make available information necessary to demonstrate compliance and allow for reasonable audits.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">6. Sub-processors</h2>
            <p className="mt-2">The Shop authorises the following sub-processors:</p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li><strong>Cloudflare, Inc.</strong> — hosting, storage, and edge infrastructure (UK/EEA region).</li>
              <li><strong>Stripe, Inc.</strong> — payment processing (PCI DSS Level 1).</li>
              <li><strong>Email/communication provider</strong> — transactional email (confirmations, reminders).</li>
            </ul>
            <p className="mt-3">
              We will inform the Shop of any intended changes concerning the addition or replacement of
              sub-processors, giving the Shop the opportunity to object.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">7. Security Measures</h2>
            <p className="mt-2">
              Encryption in transit (HTTPS/TLS), hashed password storage, session-token expiry, role-based access
              controls, foreign-key data integrity, and least-privilege access restricting personal data to
              authorised personnel. Security measures are reviewed periodically.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">8. Return and Deletion</h2>
            <p className="mt-2">
              On termination, Pivot Parlor will, at the Shop&rsquo;s choice, delete or return the personal data
              processed on the Shop&rsquo;s behalf and delete existing copies, unless retention is required by law
              (e.g. accounting records). See the Privacy Policy for retention periods.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">9. International Transfers</h2>
            <p className="mt-2">
              Personal data is hosted in the UK/EEA region. Any transfer outside the UK/EEA will be made only with
              appropriate safeguards (e.g. the UK International Data Transfer Agreement or adequacy regulations).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">10. Breach Notification</h2>
            <p className="mt-2">
              Pivot Parlor will notify the Shop without undue delay after becoming aware of a personal data breach
              affecting the Shop&rsquo;s data, and will assist the Shop with its own notification obligations to the
              ICO and affected individuals.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">11. Governing Law</h2>
            <p className="mt-2">
              This DPA is governed by the laws of England and Wales. It supplements, and is read together with, the{" "}
              <Link to="/terms" className="underline text-white/60 hover:text-white/90">Terms of Service</Link> and{" "}
              <Link to="/privacy" className="underline text-white/60 hover:text-white/90">Privacy Policy</Link>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">12. Contact</h2>
            <p className="mt-2">
              Data-protection queries: <strong>dev@pivotparlor.com</strong>, or write to BytesFX Ltd, Moselle
              Avenue, London, UK, N22 6ET.
            </p>
          </section>

        </div>
      </article>
    </main>
  );
}
