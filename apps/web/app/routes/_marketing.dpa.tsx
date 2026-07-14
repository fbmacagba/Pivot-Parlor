import type { ReactNode } from "react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { Link } from "@remix-run/react";
import { LEGAL_ENTITY, DPA_VERSION, DPA_EFFECTIVE } from "~/lib/legalEntity";

export const meta: MetaFunction = () => [
  { title: "Data Processing Agreement | Pivot Parlor" },
  {
    name: "description",
    content:
      "The UK GDPR Article 28 Data Processing Agreement between Pivot Parlor (BytesFX Ltd) as processor and each shop as controller of its customer booking data.",
  },
];

export default function DataProcessingAgreement() {
  const {
    legalName,
    tradingAs,
    jurisdiction,
    companyNumber,
    registeredOffice,
    contactEmail,
  } = LEGAL_ENTITY;

  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-3xl">
        <h1 className="font-heading text-4xl font-bold text-white">
          Data Processing Agreement
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Version {DPA_VERSION} · Effective {DPA_EFFECTIVE}
        </p>

        <div className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/60">
          <span className="font-medium text-white/80">{tradingAs}</span>
          <br />
          {legalName} · Moselle Avenue, London, UK, N22 6ET
          <br />
          {contactEmail}
        </div>

        <p className="mt-4 text-sm leading-relaxed text-white/60">
          This Agreement has been prepared in line with UK GDPR Article 28 and
          reviewed against current UK data protection guidance, including the
          Data (Use and Access) Act 2025. It is maintained under ongoing legal
          review; we publish updated versions on this page as our processing or
          the law changes.
        </p>

        <div className="mt-10 space-y-8 text-base leading-relaxed text-white/75">
          <section>
            <h2 className="text-lg font-semibold text-white/90">Purpose</h2>
            <p className="mt-2">
              Pivot Parlor is a multi-tenant booking platform. For the personal
              data of a shop&rsquo;s booking customers, the{" "}
              <strong>shop is the controller</strong> and{" "}
              <strong>
                {legalName} (trading as {tradingAs}) is the processor
              </strong>
              , processing that data on the shop&rsquo;s behalf. UK GDPR Article
              28(1) and (3) requires that relationship to be governed by a
              binding written contract containing specific mandatory terms. This
              Agreement is that contract.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">Parties</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                <strong>The Processor:</strong> {legalName}, a company
                registered in {jurisdiction}
                {companyNumber ? ` under company number ${companyNumber}` : ""},
                whose registered office is at {registeredOffice}, trading as
                &ldquo;{tradingAs}&rdquo; (&ldquo;<strong>Processor</strong>
                &rdquo;, &ldquo;<strong>we</strong>&rdquo;, &ldquo;
                <strong>us</strong>&rdquo;).
              </li>
              <li>
                <strong>The Controller:</strong> the shop, salon, or business
                that has onboarded onto the Pivot Parlor platform and accepted
                these terms (&ldquo;<strong>Shop</strong>&rdquo;, &ldquo;
                <strong>Controller</strong>&rdquo;, &ldquo;<strong>you</strong>
                &rdquo;).
              </li>
            </ul>
            <p className="mt-3">
              Together the &ldquo;<strong>Parties</strong>&rdquo;. This
              Agreement takes effect on the date the Controller accepts it (the
              &ldquo;
              <strong>Effective Date</strong>&rdquo;) and forms part of, and is
              governed by, the Pivot Parlor{" "}
              <Link
                to="/terms"
                className="text-gold underline decoration-gold/50 hover:decoration-gold"
              >
                Terms of Service
              </Link>{" "}
              (the &ldquo;<strong>Principal Agreement</strong>&rdquo;).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              1. Definitions
            </h2>
            <p className="mt-2">
              Terms used but not defined here have the meaning given in the{" "}
              <strong>UK GDPR</strong> (as defined in section 3(10) of, and see
              section 205(4) of, the Data Protection Act 2018) and the{" "}
              <strong>Data Protection Act 2018</strong> (&ldquo;
              <strong>DPA 2018</strong>&rdquo;), in each case as amended from
              time to time, including by the Data (Use and Access) Act 2025
              (together &ldquo;<strong>Data Protection Law</strong>&rdquo;).
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                &ldquo;<strong>Controller Personal Data</strong>&rdquo; means
                the Personal Data that the Processor Processes on behalf of the
                Controller under the Principal Agreement, as described in{" "}
                <strong>Annex 1</strong>.
              </li>
              <li>
                &ldquo;<strong>Personal Data</strong>&rdquo;, &ldquo;
                <strong>Processing</strong>&rdquo;, &ldquo;
                <strong>Data Subject</strong>&rdquo;, &ldquo;
                <strong>Personal Data Breach</strong>&rdquo;, &ldquo;
                <strong>Sub-processor</strong>&rdquo;, and &ldquo;
                <strong>Supervisory Authority</strong>&rdquo; have the meanings
                given in Data Protection Law.
              </li>
              <li>
                The <strong>Supervisory Authority</strong> is the Information
                Commissioner&rsquo;s Office (&ldquo;<strong>ICO</strong>&rdquo;)
                and any successor body, including the Information Commission
                established under the Data (Use and Access) Act 2025.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              2. Roles and scope of processing
            </h2>
            <p className="mt-2">
              2.1 The Parties acknowledge that, for the Controller Personal
              Data, the Controller is the <strong>controller</strong> and the
              Processor is the <strong>processor</strong>.
            </p>
            <p className="mt-3">
              2.2 The Processor shall Process Controller Personal Data only as
              necessary to provide the platform under the Principal Agreement,
              only for the subject-matter, duration, nature and purposes set out
              in <strong>Annex 1</strong>, and only in respect of the types of
              Personal Data and categories of Data Subjects set out in{" "}
              <strong>Annex 1</strong>.
            </p>
            <p className="mt-3">
              2.3 Nothing in this Agreement relieves the Controller of its own
              obligations under Data Protection Law, including providing a
              privacy notice to Data Subjects and establishing a lawful basis
              for the Processing it instructs.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              3. Processor obligations (UK GDPR Article 28(3))
            </h2>
            <p className="mt-2">The Processor shall:</p>
            <p className="mt-3">
              <strong>(a) Documented instructions.</strong> Process Controller
              Personal Data only on the Controller&rsquo;s documented
              instructions (including the instructions embodied in the Principal
              Agreement and the Controller&rsquo;s configuration and use of the
              platform), including as regards international transfers, unless
              required to do otherwise by law; in which case the Processor shall
              inform the Controller of that legal requirement before Processing,
              unless the law prohibits it. If the Processor believes an
              instruction infringes Data Protection Law, it shall inform the
              Controller without undue delay.
            </p>
            <p className="mt-3">
              <strong>(b) Confidentiality.</strong> Ensure that persons
              authorised to Process the Controller Personal Data are subject to
              an appropriate duty of confidentiality.
            </p>
            <p className="mt-3">
              <strong>(c) Security.</strong> Implement appropriate technical and
              organisational measures to ensure a level of security appropriate
              to the risk, taking account of UK GDPR Article 32, as described in{" "}
              <strong>Annex 3</strong>.
            </p>
            <p className="mt-3">
              <strong>(d) Sub-processors.</strong> Not engage another processor
              (Sub-processor) without the Controller&rsquo;s prior specific or{" "}
              <strong>general written authorisation</strong>. The Controller
              provides <strong>general authorisation</strong> for the
              Sub-processors listed in <strong>Annex 2</strong>. The Processor
              shall inform the Controller of any intended addition or
              replacement of a Sub-processor at least <strong>30 days</strong>{" "}
              in advance (or, where an upstream provider gives the Processor
              shorter notice, as soon as reasonably practicable), giving the
              Controller the opportunity to object on reasonable data-protection
              grounds; where the Processor engages a Sub-processor it shall
              impose on it, by contract, data-protection obligations equivalent
              to those in this Agreement, and remains fully liable to the
              Controller for the Sub-processor&rsquo;s performance.
            </p>
            <p className="mt-3">
              <strong>(e) Data-subject rights and complaints.</strong> Taking
              into account the nature of the Processing, assist the Controller
              by appropriate technical and organisational measures, insofar as
              possible, to respond to requests to exercise Data Subject rights
              (access, rectification, erasure, restriction, portability,
              objection) and to handle and acknowledge data-protection
              complaints within the timescales under Data Protection Law
              (including the complaints-handling duty introduced by the Data
              (Use and Access) Act 2025: acknowledge within 30 days and respond
              without undue delay). Where a Data Subject contacts the Processor
              directly regarding Controller Personal Data, the Processor shall
              promptly forward the request to the Controller and not respond
              substantively itself except on the Controller&rsquo;s instruction.
            </p>
            <p className="mt-3">
              <strong>(f) Assistance with compliance.</strong> Assist the
              Controller in ensuring compliance with its obligations under UK
              GDPR Articles 32 to 36, taking into account the nature of
              Processing and the information available to the Processor,
              including security, Personal Data Breach notification,
              communication to Data Subjects, data protection impact
              assessments, and prior consultation with the Supervisory
              Authority.
            </p>
            <p className="mt-3">
              <strong>(g) Breach notification.</strong> Notify the Controller{" "}
              <strong>without undue delay</strong>, and in any event within{" "}
              <strong>72 hours</strong>, after becoming aware of a Personal Data
              Breach affecting Controller Personal Data, and provide the
              Controller with sufficient information to meet any obligation to
              report the breach to the Supervisory Authority and/or affected
              Data Subjects.
            </p>
            <p className="mt-3">
              <strong>(h) Deletion or return.</strong> At the Controller&rsquo;s
              choice, delete or return all Controller Personal Data at the end
              of the provision of the platform services, and delete existing
              copies unless UK law requires storage. This is subject to a{" "}
              <strong>30-day</strong> grace period for retrieval, and to the
              retention of records the Processor is required by law to keep (for
              example, transaction records for accounting). Backup copies may be
              put beyond use and deleted on the next scheduled deletion cycle
              where immediate deletion is not practicable.
            </p>
            <p className="mt-3">
              <strong>(i) Demonstrate compliance and audits.</strong> Make
              available to the Controller all information necessary to
              demonstrate compliance with Article 28, and allow for and
              contribute to audits, including inspections, conducted by the
              Controller or an auditor it mandates. To protect the
              confidentiality and security of a multi-tenant environment, audits
              shall be on reasonable prior notice, no more than{" "}
              <strong>once per rolling 12 months</strong> (save following a
              Personal Data Breach or a Supervisory Authority requirement), and
              may be satisfied by the Processor providing an up-to-date
              independent audit report or security certification where
              available.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              4. International transfers
            </h2>
            <p className="mt-2">
              4.1 Some Controller Personal Data is Processed outside the United
              Kingdom. In particular, several of the Processor&rsquo;s
              Sub-processors Process personal data in the United States, and the
              platform&rsquo;s hosting infrastructure replicates certain data
              across global locations (see <strong>Annex 2</strong>). The
              platform does not guarantee UK-only or EEA-only data residency for
              all components.
            </p>
            <p className="mt-3">
              4.2 Where Controller Personal Data is transferred outside the
              United Kingdom, the Processor and its Sub-processors rely on a
              lawful transfer mechanism under Data Protection Law, applying the
              data protection test under the UK GDPR (as amended by the Data
              (Use and Access) Act 2025). These mechanisms are principally the
              UK International Data Transfer Addendum to the EU Standard
              Contractual Clauses and, where applicable, the UK Extension to the
              EU-U.S. Data Privacy Framework. The Processor does not rely on a
              UK adequacy decision for transfers to the United States. The
              mechanism relied on for each Sub-processor is set out in{" "}
              <strong>Annex 2</strong>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              5. Liability
            </h2>
            <p className="mt-2">
              5.1 Liability arising under or in connection with this Agreement
              is subject to, and governed by, the limitation of liability set
              out in Section 8 (Limitation of Liability) of the Principal
              Agreement (the Pivot Parlor{" "}
              <Link
                to="/terms"
                className="text-gold underline decoration-gold/50 hover:decoration-gold"
              >
                Terms of Service
              </Link>
              ), which the Parties agree applies to this Agreement.
            </p>
            <p className="mt-3">
              5.2 Nothing in this Agreement or the Principal Agreement limits
              either Party&rsquo;s liability to a Data Subject under Article 82
              of the UK GDPR, which allocates liability for damage caused by
              Processing by operation of law regardless of contract, or any
              other liability that cannot be excluded or limited under Data
              Protection Law.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              6. Term and termination
            </h2>
            <p className="mt-2">
              This Agreement takes effect on the Effective Date and continues
              while the Processor Processes Controller Personal Data under the
              Principal Agreement. Clauses that by their nature should survive
              (including Sections 3(h), 3(i), 4 and 5) survive termination.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              Annex 1: Details of the Processing
            </h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <tbody>
                  <AnnexRow label="Subject-matter">
                    Provision of the Pivot Parlor online booking and
                    shop-management platform to the Controller.
                  </AnnexRow>
                  <AnnexRow label="Duration">
                    For the term of the Principal Agreement, plus any retention
                    or return period in Section 3(h).
                  </AnnexRow>
                  <AnnexRow label="Nature and purpose">
                    Hosting, storing, and processing booking and
                    customer-relationship data to enable appointment booking,
                    reminders, walk-in and waitlist queues, reviews, payment
                    facilitation, and shop administration on the
                    Controller&rsquo;s behalf.
                  </AnnexRow>
                  <AnnexRow label="Types of Personal Data">
                    Customer name; email address; telephone number; appointment
                    date and time, service and staff selected; booking notes;
                    booking and transaction identifiers and amounts; and any
                    personal data a customer volunteers via the booking form,
                    walk-in or waitlist form, review, or chat. No
                    special-category data is intentionally collected.
                  </AnnexRow>
                  <AnnexRow label="Categories of Data Subjects">
                    The Controller&rsquo;s booking customers and prospective
                    customers.
                  </AnnexRow>
                  <AnnexRow label="Controller&rsquo;s obligations and rights">
                    The Controller determines the purposes and means of the
                    Processing, provides the privacy notice and lawful basis to
                    Data Subjects, issues instructions to the Processor, and has
                    the rights of authorisation, objection, audit, and deletion
                    or return set out in this Agreement.
                  </AnnexRow>
                  <AnnexRow label="Frequency">
                    Continuous, for the duration of the service.
                  </AnnexRow>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              Annex 2: Authorised Sub-processors
            </h2>
            <p className="mt-2">
              The Controller provides general written authorisation for the
              following Sub-processors (Section 3(d)). Data locations and
              transfer mechanisms reflect each provider&rsquo;s current
              published terms.
            </p>
            <div className="mt-3 space-y-4">
              <SubprocessorCard
                name="Cloudflare, Inc."
                service="Application hosting, data storage (D1, KV, R2), edge compute, and bot or security protection (Turnstile). Acts as the Processor&rsquo;s Sub-processor."
                location="Global. UK or EEA data residency is not guaranteed for all components: Workers KV replicates data across global locations, and D1 or R2 EU residency applies only where the EU jurisdiction was selected at creation."
                transfer="EU Standard Contractual Clauses as amended by the UK International Data Transfer Addendum, per the Cloudflare Customer DPA (v6.4, 3 April 2026). Data Privacy Framework certification is relied on only as a supplementary US-transfer basis."
              />
              <SubprocessorCard
                name="Stripe (Stripe Payments Europe, Ltd; Stripe Payments UK, Ltd; Stripe, LLC)"
                service="Payment processing and fraud prevention. Stripe acts as the Processor&rsquo;s processor for payment facilitation carried out on the platform&rsquo;s instructions, and as an independent controller in its own right for fraud prevention, anti-money-laundering and know-your-customer checks, and legal and regulatory compliance. Stripe Payments UK, Ltd is the FCA-authorised acquirer; Stripe, LLC is the US data importer."
                location="United Kingdom, European Economic Area, and United States."
                transfer="EU Standard Contractual Clauses and the UK International Data Transfer Addendum, supported by Stripe, LLC&rsquo;s UK Extension to the EU-U.S. Data Privacy Framework. Cardholder data is governed by Stripe&rsquo;s own Data Processing Agreement (stripe.com/legal/dpa)."
              />
              <SubprocessorCard
                name="Plus Five Five, Inc. (trading as Resend)"
                service="Transactional email delivery (booking confirmations and reminders). Acts as the Processor&rsquo;s Sub-processor."
                location="United States. Email metadata and logs are stored in the United States regardless of the sending region selected."
                transfer="UK Extension to the EU-U.S. Data Privacy Framework, with EU Standard Contractual Clauses and the UK Addendum as the fallback mechanism, per the Resend Data Processing Agreement."
              />
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">
              Annex 3: Technical and organisational security measures (Article
              32)
            </h2>
            <p className="mt-2">
              Current measures include, without limitation:
            </p>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              <li>
                Encryption of data in transit (HTTPS/TLS) across all platform
                endpoints.
              </li>
              <li>
                Passwords stored only as salted PBKDF2 hashes; no plaintext
                credential storage.
              </li>
              <li>
                Session tokens are signed (JWT), HttpOnly, Secure, and
                time-limited (7-day expiry) with server-side revocation.
              </li>
              <li>
                Role-based access control (developer, admin, staff, customer)
                with shop-scoped data isolation enforced at the query layer.
              </li>
              <li>
                Payment card data is not stored on platform systems (handled by
                Stripe).
              </li>
              <li>
                Time-based data retention and anonymisation of aged records.
              </li>
              <li>
                Point-in-time recovery and backups of the primary datastore.
              </li>
              <li>Logging and monitoring of platform activity.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-white/90">Contact</h2>
            <p className="mt-2">
              For any questions about this Agreement or to exercise a right
              under it, contact us at <strong>{contactEmail}</strong> or write
              to {tradingAs}, Moselle Avenue, London, UK, N22 6ET.
            </p>
          </section>
        </div>
      </article>
    </main>
  );
}

function AnnexRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <tr className="border-b border-white/10 align-top">
      <th className="w-1/3 py-3 pr-4 text-left font-semibold text-white/80">
        {label}
      </th>
      <td className="py-3 text-white/75">{children}</td>
    </tr>
  );
}

function SubprocessorCard({
  name,
  service,
  location,
  transfer,
}: {
  name: string;
  service: string;
  location: string;
  transfer: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <p className="font-semibold text-white/90">{name}</p>
      <dl className="mt-2 space-y-1.5 text-sm">
        <div>
          <dt className="inline font-medium text-white/70">Service: </dt>
          <dd className="inline text-white/75">{service}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-white/70">Location: </dt>
          <dd className="inline text-white/75">{location}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-white/70">
            Transfer mechanism:{" "}
          </dt>
          <dd className="inline text-white/75">{transfer}</dd>
        </div>
      </dl>
    </div>
  );
}
