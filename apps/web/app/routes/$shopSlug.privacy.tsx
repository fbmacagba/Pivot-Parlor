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
  return [{ title: `Privacy Policy | ${name}` }];
};

export default function ShopPrivacyPolicy() {
  const data = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  if (!data?.shop) return null;

  const site = data.site as ShopSiteData | null;
  const siteChrome = siteDataForChrome(data.shop.name, site, data.shop.id);
  const slug = data.slug;

  return (
    <CommercialShopChrome site={siteChrome} settings={data.settings ?? {}} shopSlug={slug}>
      <ShopLegalDocument title="Privacy Policy" shopName={data.shop.name}>
        <p>
          This Privacy Policy describes how <strong>{data.shop.name}</strong> (&quot;we&quot;, &quot;us&quot;, or
          &quot;our&quot;) collects, uses, and shares information when you use our website and booking services
          provided through Pivot Parlor.
        </p>
        <p>
          We collect information you provide when booking an appointment (such as name, contact details, and
          appointment preferences), technical data (such as IP address and browser type), and communications you send
          to us. We use this information to provide and improve our services, confirm appointments, and comply with
          legal obligations.
        </p>
        <p>
          We may share information with service providers who assist us in operating our business (for example,
          hosting and scheduling infrastructure), when required by law, or to protect our rights and safety.
        </p>
        <p>
          Depending on where you live, you may have rights to access, correct, or delete certain personal data. To
          exercise these rights, contact us using the details shown on our website.
        </p>
        <p>
          Our site may use cookies and similar technologies. See our Cookie Policy for more information and choices
          where available.
        </p>
        <p>
          If you have questions about this Privacy Policy, please contact <strong>{data.shop.name}</strong> directly.
        </p>
      </ShopLegalDocument>
    </CommercialShopChrome>
  );
}
