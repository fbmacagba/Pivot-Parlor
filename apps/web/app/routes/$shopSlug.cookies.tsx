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
  const siteChrome = siteDataForChrome(data.shop.name, site);
  const slug = data.slug;

  return (
    <CommercialShopChrome site={siteChrome} settings={data.settings ?? {}} shopSlug={slug}>
      <ShopLegalDocument title="Cookie Policy" shopName={data.shop.name}>
        <p>
          This Cookie Policy explains how <strong>{data.shop.name}</strong> uses cookies and similar technologies on
          this website, including pages powered by Pivot Parlor.
        </p>
        <p>
          Cookies are small text files stored on your device. We use essential cookies that are required for the site
          to function (for example, security and session management). Where you have consented, we may also use
          analytics or marketing cookies to understand how visitors use the site and to improve our services.
        </p>
        <p>
          You can control non-essential cookies through the cookie preferences tool on our site where available, and
          through your browser settings. Blocking some cookies may affect how certain features work.
        </p>
        <p>
          We may update this Cookie Policy from time to time. The &quot;Last updated&quot; date at the top of this
          page reflects the latest revision.
        </p>
        <p>
          For more information about how we handle personal data, see our Privacy Policy. Questions? Contact{" "}
          <strong>{data.shop.name}</strong>.
        </p>
      </ShopLegalDocument>
    </CommercialShopChrome>
  );
}
