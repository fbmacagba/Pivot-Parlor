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
  return [{ title: `Cookie Policy | ${name}` }];
};

export default function ShopCookiePolicy() {
  const data = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  if (!data?.shop) return null;

  const site = data.site as ShopSiteData | null;
  const siteChrome = siteDataForChrome(data.shop.name, site, data.shop.id);
  const slug = data.slug;
  const shopName = data.shop.name;
  const address = data.settings?.address ?? null;

  return (
    <CommercialShopChrome site={siteChrome} settings={data.settings ?? {}} shopSlug={slug}>
      <ShopLegalDocument title="Cookie Policy" shopName={shopName} address={address}>

        {/* 1. What are cookies */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">1. What Are Cookies?</h2>
        <p>
          Cookies are small text files that are placed on your device (computer, smartphone, or tablet) when
          you visit a website. They are widely used to make websites work efficiently, to remember your
          preferences, and to provide information to website owners.
        </p>
        <p>
          This Cookie Policy explains how <strong>{shopName}</strong>, operating through the Pivot Parlor
          platform, uses cookies and similar technologies on this website. It should be read alongside our{" "}
          <a href={`/${slug}/privacy`} className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]">
            Privacy Policy
          </a>
          .
        </p>
        <p>
          Our use of cookies is governed by the UK Privacy and Electronic Communications Regulations (PECR) and
          the UK General Data Protection Regulation (UK GDPR).
        </p>

        {/* 2. Cookies we use */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">2. Cookies We Use</h2>
        <p>We use the following categories of cookies on this website:</p>

        <h3 className="font-semibold text-[color:var(--st-ink-80)]">2.1 Strictly Necessary Cookies</h3>
        <p>
          These cookies are essential for the website to function and cannot be switched off. They are usually
          set in response to actions you take, such as logging in, making a booking, or setting your privacy
          preferences. You can set your browser to block or alert you about these cookies, but some parts of
          the site will not then work.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <strong>pp_session</strong> — stores your login session token. Set when you sign in.
            Expires after 7 days or on logout. HttpOnly, Secure.
          </li>
          <li>
            <strong>Cookie preference</strong> — remembers your cookie consent choices.
            Stored in your browser&rsquo;s local storage.
          </li>
        </ul>

        <h3 className="font-semibold text-[color:var(--st-ink-80)]">2.2 Analytics Cookies</h3>
        <p>
          These cookies allow us to count visits and understand how visitors interact with our website, so we
          can measure and improve its performance. All information these cookies collect is aggregated and
          therefore anonymous. If you do not allow these cookies we will not know when you have visited our
          site.
        </p>
        <p>
          We only set analytics cookies where you have given your consent via our cookie preference centre.
        </p>

        <h3 className="font-semibold text-[color:var(--st-ink-80)]">2.3 Marketing Cookies</h3>
        <p>
          These cookies may be set through our site by our advertising partners. They may be used to build a
          profile of your interests and show you relevant adverts on other sites. They do not store directly
          personal information, but are based on uniquely identifying your browser and internet device.
        </p>
        <p>
          We only set marketing cookies where you have given your explicit consent via our cookie preference
          centre.
        </p>

        {/* 3. Third-party cookies */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">3. Third-Party Cookies</h2>
        <p>
          Some cookies on our website are set by third-party services that appear on our pages. We do not
          control the setting of these cookies and you should check the relevant third party&rsquo;s website
          for more information about their cookies and how to manage them. Third-party services that may set
          cookies include:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Stripe</strong> — used to process payments securely. Stripe may set cookies related to
            fraud prevention and payment authentication. See{" "}
            <a
              href="https://stripe.com/gb/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]"
            >
              Stripe&rsquo;s Privacy Policy
            </a>
            .
          </li>
          <li>
            <strong>Social login providers</strong> (Google, Facebook, LinkedIn) — if you use social login,
            these providers may set their own cookies. Please refer to their respective privacy policies.
          </li>
        </ul>

        {/* 4. Managing cookies */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">4. How to Manage Your Cookie Preferences</h2>
        <p>
          You can manage non-essential cookies at any time through our cookie preference centre, accessible via
          the &ldquo;Manage cookie preferences&rdquo; link in the footer of this website.
        </p>
        <p>
          You can also control cookies through your browser settings. Most browsers allow you to:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>View what cookies are stored and delete them individually.</li>
          <li>Block third-party cookies.</li>
          <li>Block cookies from particular sites.</li>
          <li>Block all cookies from being set.</li>
          <li>Delete all cookies when you close your browser.</li>
        </ul>
        <p>
          Please note that if you disable all cookies, some features of this website may not work correctly,
          including the ability to log in or complete a booking.
        </p>
        <p>
          For guidance on managing cookies in your browser, visit{" "}
          <a
            href="https://www.aboutcookies.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]"
          >
            aboutcookies.org
          </a>{" "}
          or{" "}
          <a
            href="https://www.allaboutcookies.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]"
          >
            allaboutcookies.org
          </a>
          .
        </p>

        {/* 5. Your rights */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">5. Your Rights</h2>
        <p>
          Under PECR and UK GDPR, you have the right to withdraw your consent to the use of non-essential
          cookies at any time. You can do this through our cookie preference centre or by clearing your
          cookies in your browser settings.
        </p>
        <p>
          For more information about your data rights and how we use your personal data, please see our{" "}
          <a href={`/${slug}/privacy`} className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]">
            Privacy Policy
          </a>
          .
        </p>
        <p>
          If you have concerns about our use of cookies, you have the right to lodge a complaint with the{" "}
          <strong>Information Commissioner&rsquo;s Office (ICO)</strong> at{" "}
          <a
            href="https://ico.org.uk"
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[color:var(--st-ink-60)] hover:text-[color:var(--st-ink-90)]"
          >
            ico.org.uk
          </a>
          .
        </p>

        {/* 6. Changes */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">6. Changes to This Cookie Policy</h2>
        <p>
          We may update this Cookie Policy from time to time to reflect changes in technology, law, or our
          data practices. Any updates will be posted on this page with a revised &ldquo;Last updated&rdquo;
          date. We encourage you to check this page periodically.
        </p>

        {/* 7. Contact */}
        <h2 className="text-lg font-semibold text-[color:var(--st-ink-90)]">7. Contact Us</h2>
        <p>
          If you have any questions about this Cookie Policy, please contact{" "}
          <strong>{shopName}</strong> using the details on our main page
          {address ? <>, or write to us at <strong>{address}</strong></> : null}.
        </p>

      </ShopLegalDocument>
    </CommercialShopChrome>
  );
}
