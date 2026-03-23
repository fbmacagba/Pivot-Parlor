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
  const siteChrome = siteDataForChrome(data.shop.name, site);
  const slug = data.slug;

  return (
    <CommercialShopChrome site={siteChrome} settings={data.settings ?? {}} shopSlug={slug}>
      <ShopLegalDocument title="Terms of Service" shopName={data.shop.name}>
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your use of the website and online booking services of{" "}
          <strong>{data.shop.name}</strong> (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;), including services
          made available through Pivot Parlor.
        </p>
        <p>
          By accessing our site or completing a booking, you agree to these Terms. If you do not agree, please do not
          use our services.
        </p>
        <p>
          We provide appointment booking and related information as described on our site. Service descriptions,
          pricing, and availability may change; we aim to keep information accurate but do not warrant that all
          content is complete or error-free.
        </p>
        <p>
          You agree to provide accurate information when booking and to arrive on time for appointments. Cancellation
          and no-show policies may apply as stated at booking or by <strong>{data.shop.name}</strong>.
        </p>
        <p>
          To the fullest extent permitted by law, our liability arising from your use of the site or services is
          limited as permitted by applicable law. Nothing in these Terms excludes liability that cannot be excluded by
          law.
        </p>
        <p>
          These Terms may be updated from time to time. Continued use of the site after changes constitutes acceptance
          of the revised Terms.
        </p>
        <p>
          For questions about these Terms, contact <strong>{data.shop.name}</strong>.
        </p>
      </ShopLegalDocument>
    </CommercialShopChrome>
  );
}
