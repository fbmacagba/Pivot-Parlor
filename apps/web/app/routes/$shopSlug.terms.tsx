import { useRouteLoaderData } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import { ShopLegalDocument } from "~/components/ShopLegalDocument";
import { siteDataForChrome } from "~/lib/shopCommercialChrome";
import type { loader as shopLoader } from "./$shopSlug";
import type { ShopSiteData } from "./$shopSlug";

export const meta: MetaFunction = ({ matches }) => {
  const d = matches.find((m) => m.id === "routes/$shopSlug")?.data as
    | { shop?: { name?: string } }
    | undefined;
  const name = d?.shop?.name ?? "Shop";
  return [{ title: `Terms of Service | ${name}` }];
};

export default function ShopTermsOfService() {
  const data = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  if (!data?.shop) return null;

  const site = data.site as ShopSiteData | null;
  const siteChrome = siteDataForChrome(data.shop.name, site, data.shop.id);
  const slug = data.slug;
  const shopName = data.shop.name;
  const address = data.settings?.address ?? null;

  return (
    <CommercialShopChrome site={siteChrome} settings={data.settings ?? {}} shopSlug={slug}>
      <ShopLegalDocument title="Terms of Service" shopName={shopName} address={address}>

        {/* 1. About us */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">1. About Us</h2>
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the website and online booking
          services operated by <strong>{shopName}</strong> (&ldquo;we&rdquo;, &ldquo;us&rdquo;, or
          &ldquo;our&rdquo;), delivered in partnership with Pivot Parlor.
          {address ? (
            <> Our business address is <strong>{address}</strong>.</>
          ) : null}
        </p>
        <p>
          By accessing this website or placing a booking, you confirm that you have read, understood, and agree
          to be bound by these Terms. If you do not agree, please do not use our services.
        </p>

        {/* 2. Our services */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">2. Our Services</h2>
        <p>
          We provide professional beauty and/or barbering services bookable through this website. Service
          descriptions, pricing, staff availability, and opening hours are provided for information purposes and
          may be updated from time to time. We aim to ensure all information is accurate, but we do not warrant
          that it is complete, current, or error-free.
        </p>
        <p>
          The availability of any service or staff member is not guaranteed until your booking is confirmed.
          We reserve the right to substitute a staff member with an equally qualified member of our team where
          necessary.
        </p>

        {/* 3. Booking */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">3. Making a Booking</h2>
        <p>
          When making a booking through our website, you agree to provide accurate and complete information,
          including your name, contact details, and any relevant information about the service you require.
          A booking confirmation will be sent to the email address you provide.
        </p>
        <p>
          Your booking is confirmed only once you have received a confirmation from us. We reserve the right to
          decline or cancel bookings at our discretion, in which case any payment taken will be refunded in full.
        </p>

        {/* 4. Cancellation and no-shows */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">4. Cancellations, Rescheduling, and No-Shows</h2>
        <p>
          We kindly ask that you give us as much notice as possible if you need to cancel or reschedule your
          appointment. Cancellations made with less than 24 hours&rsquo; notice, or failure to attend without
          notice (&ldquo;no-show&rdquo;), may result in a cancellation fee or the forfeiture of any deposit paid.
        </p>
        <p>
          We reserve the right to cancel or reschedule your appointment due to unforeseen circumstances, staff
          illness, or events beyond our control. In such cases, we will contact you as soon as possible and
          offer an alternative date, time, or a full refund of any amount paid.
        </p>

        {/* 5. Payments */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">5. Prices and Payments</h2>
        <p>
          All prices displayed on this website are in pounds sterling (GBP) and are inclusive of VAT where
          applicable. Prices are subject to change; the price applicable to your booking will be confirmed at
          the time of booking.
        </p>
        <p>
          Where a deposit or payment is required at the time of booking, this will be clearly indicated before
          you confirm. Payments are processed securely through Stripe. We do not store your full payment card
          details on our systems.
        </p>

        {/* 6. Your responsibilities */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">6. Your Responsibilities</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Arrive on time for your appointment. Late arrivals may result in a shortened appointment.</li>
          <li>
            Inform us of any allergies, health conditions, or sensitivities relevant to the services you are
            booking before or at the time of your appointment.
          </li>
          <li>Treat our staff and other clients with courtesy and respect.</li>
          <li>
            Use our website only for lawful purposes and in a manner that does not infringe the rights of others.
          </li>
        </ul>

        {/* 7. Intellectual property */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">7. Intellectual Property</h2>
        <p>
          All content on this website, including but not limited to text, images, graphics, logos, and software,
          is the property of <strong>{shopName}</strong> or its licensors and is protected by applicable
          intellectual property laws. You may not reproduce, distribute, or create derivative works from any
          content without our prior written consent.
        </p>

        {/* 8. Limitation of liability */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">8. Limitation of Liability</h2>
        <p>
          To the fullest extent permitted by applicable law, <strong>{shopName}</strong> shall not be liable
          for any indirect, incidental, special, consequential, or punitive damages arising from your use of
          our website or services. Our total liability to you shall not exceed the amount paid by you for the
          specific service giving rise to the claim.
        </p>
        <p>
          Nothing in these Terms excludes or limits our liability for death or personal injury caused by our
          negligence, fraud or fraudulent misrepresentation, or any other liability that cannot be excluded or
          limited under English law.
        </p>

        {/* 9. Consumer rights */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">9. Consumer Rights</h2>
        <p>
          If you are a consumer (i.e. you are using our services for personal, non-business purposes), nothing
          in these Terms affects your statutory rights under the Consumer Rights Act 2015 or any other
          applicable UK consumer protection legislation, including the Digital Markets, Competition and Consumers
          Act 2024.
        </p>

        {/* 10. Governing law */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">10. Governing Law</h2>
        <p>
          These Terms are governed by and construed in accordance with the laws of England and Wales. Any
          disputes arising in connection with these Terms shall be subject to the exclusive jurisdiction of the
          courts of England and Wales.
        </p>

        {/* 11. Changes */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">11. Changes to These Terms</h2>
        <p>
          We may update these Terms from time to time. Any changes will be posted on this page with an updated
          &ldquo;Last updated&rdquo; date. Your continued use of our website or services after changes are
          posted constitutes your acceptance of the revised Terms.
        </p>

        {/* 12. Contact */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">12. Contact Us</h2>
        <p>
          If you have any questions about these Terms, please contact <strong>{shopName}</strong> using the
          details on our main page{address ? <>, or write to us at <strong>{address}</strong></> : null}.
        </p>

      </ShopLegalDocument>
    </CommercialShopChrome>
  );
}
