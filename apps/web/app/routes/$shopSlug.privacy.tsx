import { useRouteLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import { ShopLegalDocument } from "~/components/ShopLegalDocument";
import { SHOP_LEGAL_LAST_UPDATED } from "~/lib/legalDates";
import { siteDataForChrome } from "~/lib/shopCommercialChrome";
import type { loader as shopLoader } from "./$shopSlug";
import type { ShopSiteData } from "./$shopSlug";

export const meta: MetaFunction = ({ matches }) => {
  const d = matches.find((m) => m.id === "routes/$shopSlug")?.data as
    | { shop?: { name?: string } }
    | undefined;
  const name = d?.shop?.name ?? "Shop";
  return [{ title: `Privacy Policy | ${name}` }];
};

export default function ShopPrivacyPolicy() {
  const data = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  if (!data?.shop) return null;

  const site = data.site as ShopSiteData | null;
  const siteChrome = siteDataForChrome(data.shop.name, site, data.shop.id);
  const slug = data.slug;
  const shopName = data.shop.name;
  const address = data.settings?.address ?? null;

  return (
    <CommercialShopChrome
      site={siteChrome}
      settings={data.settings ?? {}}
      shopSlug={slug}
    >
      <ShopLegalDocument
        title="Privacy Policy"
        shopName={shopName}
        address={address}
        lastUpdated={SHOP_LEGAL_LAST_UPDATED.privacy}
      >
        {/* 1. Who we are */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          1. Who We Are
        </h2>
        <p>
          <strong>{shopName}</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or
          &ldquo;our&rdquo;) is the data controller responsible for your
          personal data collected through this website and booking service,
          which is operated in partnership with Pivot Parlor.
          {address ? (
            <>
              {" "}
              Our registered business address is: <strong>{address}</strong>.
            </>
          ) : null}
        </p>
        <p>
          We take your privacy seriously and are committed to protecting your
          personal data in accordance with the UK General Data Protection
          Regulation (UK GDPR) and the Data Protection Act 2018.
        </p>

        {/* 2. Data we collect */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          2. Personal Data We Collect
        </h2>
        <p>We collect and process the following categories of personal data:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Booking information:</strong> your name, email address,
            phone number, preferred appointment date and time, and service
            requested.
          </li>
          <li>
            <strong>Communications:</strong> messages you send to us via our
            contact form, email, or chatbot.
          </li>
          <li>
            <strong>Account data:</strong> email address and password (hashed)
            if you create an account through our booking platform, or your name
            and email if you sign in via a social login provider (Google,
            Facebook, or LinkedIn).
          </li>
          <li>
            <strong>Technical data:</strong> IP address, browser type and
            version, time zone, and operating system, collected automatically
            when you access our website.
          </li>{" "}
        </ul>
        <p>
          We do not collect sensitive personal data (such as health or biometric
          information) unless you voluntarily provide it in a message to us. We
          do not knowingly collect data from children under 16.
        </p>

        {/* 3. How we use your data */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          3. How We Use Your Personal Data
        </h2>
        <p>
          We use your personal data for the following purposes and on the
          following lawful bases:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>To process and confirm your booking</strong> — lawful basis:
            performance of a contract (Article 6(1)(b) UK GDPR).
          </li>
          <li>
            <strong>To send appointment reminders and confirmations</strong> —
            lawful basis: performance of a contract / legitimate interests.
          </li>
          <li>
            <strong>To respond to your enquiries and messages</strong> — lawful
            basis: legitimate interests.
          </li>
          <li>
            <strong>To manage your account</strong> if you register on the
            platform — lawful basis: performance of a contract.
          </li>{" "}
          <li>
            <strong>To comply with legal obligations</strong> — lawful basis:
            compliance with a legal obligation (Article 6(1)(c) UK GDPR).
          </li>
        </ul>
        <p>
          We will only use your personal data for the purposes for which we
          collected it, unless we reasonably consider that we need to use it for
          another reason that is compatible with the original purpose.
        </p>

        {/* 4. Data sharing */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          4. Who We Share Your Data With
        </h2>
        <p>
          We do not sell your personal data. We may share it with the following
          third parties, all of whom are required to process your data securely
          and in accordance with the law:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Pivot Parlor</strong> - our booking platform provider, which
            hosts and processes booking data on our behalf as a data processor,
            using Cloudflare for infrastructure. Some data is processed outside
            the UK (including in the United States) and replicated across global
            locations, so UK-only or EEA-only residency is not guaranteed.
          </li>
          <li>
            <strong>Payment processors</strong> - Stripe (Stripe Payments
            Europe, Ltd and Stripe Payments UK, Ltd, with Stripe, LLC in the
            United States), to process payments securely. Stripe is certified to
            PCI DSS Level 1 and we do not store your full payment card details.
          </li>
          <li>
            <strong>Email and communication providers</strong> - Resend (Plus
            Five Five, Inc., United States), used to deliver appointment
            confirmations and reminders to you.
          </li>{" "}
          <li>
            <strong>Law enforcement or regulators</strong> - where required to
            do so by law or to protect our rights, property, or safety.
          </li>
        </ul>
        <p>
          Where personal data is transferred outside the UK, it is protected by
          a lawful transfer mechanism such as the UK International Data Transfer
          Addendum to the EU Standard Contractual Clauses or the UK Extension to
          the EU-U.S. Data Privacy Framework.
        </p>

        {/* 5. Data retention */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          5. Data Retention
        </h2>
        <p>
          We retain personal data only for as long as necessary to fulfil the
          purposes for which it was collected, including for the purposes of
          satisfying any legal, accounting, or reporting requirements.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Booking records are retained for up to 3 years from the date of the
            appointment.
          </li>
          <li>
            Account data is retained for as long as your account remains active.
          </li>
          <li>Communication records are retained for up to 1 year.</li>
          <li>
            Technical and usage data (server logs) are typically retained for up
            to 90 days.
          </li>
        </ul>

        {/* 6. Your rights */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          6. Your Rights Under UK GDPR
        </h2>
        <p>
          Under UK GDPR, you have the following rights in relation to your
          personal data:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Right of access</strong> — to request a copy of the personal
            data we hold about you.
          </li>
          <li>
            <strong>Right to rectification</strong> — to request correction of
            inaccurate or incomplete data.
          </li>
          <li>
            <strong>Right to erasure</strong> — to request deletion of your
            personal data in certain circumstances.
          </li>
          <li>
            <strong>Right to restrict processing</strong> — to request that we
            limit how we use your data.
          </li>
          <li>
            <strong>Right to data portability</strong> — to receive your data in
            a structured, machine-readable format.
          </li>
          <li>
            <strong>Right to object</strong> — to object to processing based on
            legitimate interests or for direct marketing.
          </li>
          <li>
            <strong>Rights related to automated decision-making</strong> — we do
            not make solely automated decisions that significantly affect you.
          </li>
        </ul>
        <p>
          To exercise any of these rights, please contact us using the details
          shown on our main page
          {address ? (
            <>
              , or write to us at <strong>{address}</strong>
            </>
          ) : null}
          . We will respond within 30 days. You also have the right to lodge a
          complaint with the{" "}
          <strong>Information Commissioner&rsquo;s Office (ICO)</strong> at{" "}
          <a
            href="https://ico.org.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]"
          >
            ico.org.uk
          </a>{" "}
          or by calling 0303 123 1113.
        </p>

        {/* 7. Security */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          7. Data Security
        </h2>
        <p>
          We have implemented appropriate technical and organisational measures
          to protect your personal data against accidental loss, unauthorised
          access, disclosure, alteration, or destruction. These measures include
          encrypted data transmission (HTTPS/TLS), hashed password storage,
          session token expiry, and access controls restricting data to
          authorised personnel only.
        </p>
        <p>
          In the event of a personal data breach that is likely to result in a
          risk to your rights and freedoms, we will notify the ICO within 72
          hours and, where required, notify you directly.
        </p>

        {/* 8. Cookies */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          8. Cookies
        </h2>
        <p>
          Our website uses cookies and similar technologies. Please see our{" "}
          <a
            href={`/${slug}/cookies`}
            className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]"
          >
            Cookie Policy
          </a>{" "}
          for full details on what cookies we use, why, and how to manage your
          preferences.
        </p>

        {/* 9. Third-party links */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          9. Third-Party Links
        </h2>
        <p>
          Our website may include links to third-party websites, plug-ins, and
          applications. Clicking on those links may allow third parties to
          collect or share data about you. We do not control those third-party
          websites and are not responsible for their privacy practices. We
          encourage you to read the privacy notice of every website you visit.
        </p>

        {/* 10. Changes */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">
          10. Changes to This Policy
        </h2>
        <p>
          We may update this Privacy Policy from time to time. Any changes will
          be posted on this page with an updated &ldquo;Last updated&rdquo;
          date. We encourage you to review this policy periodically.
        </p>
      </ShopLegalDocument>
    </CommercialShopChrome>
  );
}
