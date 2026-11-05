import { Form, useActionData, useNavigation, useParams, useRouteLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { isPortfolioDemoShop, PORTFOLIO_DEMO_ERROR } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import { siteDataForChrome } from "~/lib/shopCommercialChrome";
import {
  ThemedButton,
  ThemedInput,
  lightDark,
  platformFallbackVars,
} from "~/components/ThemedBookingControls";
import type { loader as shopLoader, ShopSiteData } from "./$shopSlug";

export async function loader({ params }: LoaderFunctionArgs) {
  if (isPortfolioDemoShop(params.shopSlug)) return redirect(`/${params.shopSlug}/book`);
  return json({ slug: params.shopSlug });
}

export async function action({ params, request, context }: ActionFunctionArgs) {
  if (isPortfolioDemoShop(params.shopSlug)) return json({ success: false, error: PORTFOLIO_DEMO_ERROR }, { status: 403 });
  const env = context.env as { API_URL: string };
  const form = await request.formData();
  try {
    await createApiClient(env.API_URL).post("/api/waitlist", {
      shop_slug: params.shopSlug,
      customer_name: form.get("name"),
      customer_email: form.get("email"),
      customer_phone: form.get("phone"),
      preferred_date: form.get("preferred_date"),
      service_id: form.get("service_id"),
    });
    return json({ success: true });
  } catch (e: unknown) {
    return json({ success: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

export default function Waitlist() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const { shopSlug } = useParams();
  const layoutData = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  const site = (layoutData?.site ?? null) as ShopSiteData | null;

  const body = (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--st-bg)] px-4 text-[color:var(--st-ink)]">
      <div className="w-full max-w-md">
        <h1 className="font-heading text-3xl font-bold text-[color:var(--st-ink)] mb-2">Join the waitlist</h1>
        <p className="text-[color:var(--st-ink-60)] mb-8">We&apos;ll notify you as soon as a slot opens up.</p>

        {data?.success ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
            <p className="text-2xl mb-2">🎉</p>
            <h2 className="font-heading text-xl font-bold text-[color:var(--st-ink)]">You&apos;re on the list!</h2>
            <p className="mt-2 text-[color:var(--st-ink-60)]">We&apos;ll reach out when a slot becomes available.</p>
          </div>
        ) : (
          <Form method="post" className="space-y-4 rounded-2xl border border-[color:var(--st-line-10)] bg-[color:var(--st-card)] p-8">
            {data && !data.success && "error" in data && (
              <div
                className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400"
                style={lightDark("#b91c1c", "#f87171")}
              >
                {"error" in data ? (data.error as string) : "An error occurred"}
              </div>
            )}
            <ThemedInput label="Full name" name="name" required />
            <ThemedInput label="Email address" name="email" type="email" required />
            <ThemedInput label="Phone (optional)" name="phone" type="tel" />
            <ThemedInput label="Preferred date (optional)" name="preferred_date" type="date" />
            <ThemedButton type="submit" disabled={nav.state === "submitting"} className="w-full" size="lg">
              {nav.state === "submitting" ? "Joining…" : "Join waitlist →"}
            </ThemedButton>
            <p className="text-center text-xs text-[color:var(--st-ink-50)]">
              We use these details only to add you to the waitlist and let you
              know when a slot opens. See our{" "}
              <a
                href={`/${shopSlug}/privacy`}
                className="underline hover:text-[color:var(--st-ink-80)]"
              >
                Privacy Policy
              </a>
              .
            </p>
          </Form>
        )}
      </div>
    </div>
  );

  if (layoutData?.shop && site) {
    return (
      <CommercialShopChrome
        site={siteDataForChrome(layoutData.shop.name, site, layoutData.shop.id)}
        settings={layoutData.settings ?? {}}
        shopSlug={layoutData.slug}
        bookingBar={false}
      >
        {body}
      </CommercialShopChrome>
    );
  }
  return (
    <div className="pp-commercial" style={platformFallbackVars}>
      {body}
    </div>
  );
}
