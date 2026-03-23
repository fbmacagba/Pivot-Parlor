import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Loader2, X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "~/components/ui/Button";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import type { ShopSiteData } from "./$shopSlug";
import type { DevShopDetail } from "./dev.shops.$shopId";

function shopNameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase() || "?";
}

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const shopId = params.shopId!;
  const token = getSessionToken(request);
  if (!token) throw new Response("Unauthorized", { status: 401 });

  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));

  let shop: DevShopDetail;
  try {
    shop = await api.get<DevShopDetail>(`/api/shops/${shopId}`);
  } catch {
    throw new Response("Shop not found", { status: 404 });
  }

  let site: ShopSiteData;
  try {
    site = await api.get<ShopSiteData>(`/api/shops/${shop.slug}/site`);
  } catch {
    throw new Response("No site generated yet", { status: 404 });
  }

  return json({ shop, site });
}

export default function DevShopPreview() {
  const { shop, site } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const activateFetcher = useFetcher<{ ok?: boolean }>();

  useEffect(() => {
    if (activateFetcher.state !== "idle" || !activateFetcher.data) return;
    const d = activateFetcher.data;
    if (d && typeof d === "object" && "ok" in d && d.ok === true) {
      navigate("/dev/shops");
    }
  }, [activateFetcher.state, activateFetcher.data, navigate]);

  const rootStyle = {
    "--color-brand": site.color_primary || "#1a1a1a",
    "--color-accent": site.color_accent || "#d4a853",
  } as React.CSSProperties;

  const displayName = site.headline?.trim() || shop.name;
  const tagline = site.tagline?.trim() || "Your tagline will appear here.";

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black/92 text-white backdrop-blur-sm"
      style={rootStyle}
    >
      <div className="absolute right-4 top-4 z-20 md:right-6 md:top-6">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-2 border border-white/20 bg-white/5"
          onClick={() => navigate("/dev/shops")}
        >
          <X className="h-4 w-4" />
          Close Preview
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <header className="shrink-0 border-b border-white/10 bg-[color:var(--color-brand)]/95 backdrop-blur-md">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6">
            <div className="flex min-h-12 items-center gap-3">
              {site.logo_url ? (
                <img src={site.logo_url} alt="" className="h-10 w-auto object-contain" />
              ) : (
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--color-accent)]/50 bg-[color:var(--color-accent)]/15 font-heading text-sm font-bold text-[color:var(--color-accent)]"
                  aria-hidden
                >
                  {shopNameInitials(displayName)}
                </span>
              )}
              <span className="font-heading text-[clamp(1rem,2.5vw,1.25rem)] font-semibold text-white">
                {displayName}
              </span>
            </div>
            <nav className="hidden md:block">
              <span className="inline-flex min-h-12 items-center rounded-lg bg-[color:var(--color-accent)] px-6 text-sm font-semibold text-black">
                Book Now
              </span>
            </nav>
          </div>
        </header>

        <section className="relative flex min-h-[70vh] flex-1 flex-col justify-end overflow-hidden">
          <div className="absolute inset-0">
            {site.hero_image_url ? (
              <>
                <img src={site.hero_image_url} alt="" className="h-full w-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-transparent" />
              </>
            ) : (
              <>
                <div
                  className="h-full w-full"
                  style={{
                    background: "linear-gradient(135deg, var(--color-brand) 0%, var(--color-accent) 100%)",
                  }}
                  aria-hidden
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />
              </>
            )}
          </div>

          <div className="relative z-10 mx-auto max-w-7xl px-4 pb-16 pt-24 md:px-6 md:pb-24">
            <h1 className="font-heading text-[clamp(2rem,6vw,3.75rem)] font-bold leading-tight text-white">
              {displayName}
            </h1>
            <h2 className="mt-3 max-w-2xl text-[clamp(1rem,2.8vw,1.5rem)] font-normal text-white/85">
              {tagline}
            </h2>
            <div className="mt-8 flex flex-wrap gap-4">
              <span className="inline-flex min-h-12 items-center justify-center rounded-lg bg-[color:var(--color-accent)] px-8 text-sm font-semibold text-black">
                Book Now
              </span>
              <span className="inline-flex min-h-12 items-center justify-center rounded-lg border-2 border-white/40 px-8 text-sm font-semibold text-white">
                View Services
              </span>
            </div>
          </div>
        </section>
      </div>

      <div className="absolute bottom-4 right-4 z-20 md:bottom-6 md:right-6">
        <activateFetcher.Form method="post" action={`/api/shops/${shop.id}/activate`}>
          <Button
            type="submit"
            size="sm"
            className="bg-emerald-700 hover:bg-emerald-600"
            disabled={activateFetcher.state !== "idle"}
          >
            {activateFetcher.state !== "idle" ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Activating…
              </>
            ) : (
              "Activate Website"
            )}
          </Button>
        </activateFetcher.Form>
      </div>
    </div>
  );
}
