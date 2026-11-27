import { Link, useFetcher, useLoaderData, useNavigate, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { getSessionToken, requireRole } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import type { ShopSiteData } from "./$shopSlug";

export const meta = () => pageTitle("Site summary");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev/shops" homeLabel="Back to shops" />;
}

// The public GET /api/shops/:id returns this minimal shape (the summary only
// needs the name/slug to render the header + fetch the site).
type PreviewShop = { id: string; shop_number: number; name: string; slug: string; type: string };

function shopNameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase() || "?";
}

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const shopId = params.shopId!;
  const env = context.env as { API_URL: string };
  // The shop and site reads below are public API endpoints, so this is the
  // only check that keeps the developer preview to developers.
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  if (!token) throw new Response("Unauthorized", { status: 401 });

  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));

  let shop: PreviewShop;
  try {
    shop = await api.get<PreviewShop>(`/api/shops/${encodeURIComponent(shopId)}`);
  } catch {
    throw new Response("Shop not found", { status: 404 });
  }

  let site: ShopSiteData;
  try {
    site = await api.get<ShopSiteData>(`/api/shops/${encodeURIComponent(shop.slug)}/site`);
  } catch {
    throw new Response("No site generated yet", { status: 404 });
  }

  return json({ shop, site, publicOrigin: new URL(request.url).origin });
}

type ActivateReply = { ok?: boolean; success?: boolean; error?: string };

export default function DevShopPreview() {
  const { shop, site, publicOrigin } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const activateFetcher = useFetcher<ActivateReply>();
  const [confirming, setConfirming] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);

  useFetcherResult(activateFetcher, (reply) => {
    if (reply.ok === true || reply.success === true) {
      setConfirming(false);
      navigate("/dev/shops");
    } else {
      setActivateError(
        `The site could not be made live. It is still a draft.${reply.error?.trim() ? ` (${reply.error.trim()})` : " Please try again."}`,
      );
    }
  });

  const rootStyle = {
    "--color-brand": site.color_primary || "#1a1a1a",
    "--color-accent": site.color_accent || "#d4a853",
  } as React.CSSProperties;

  const displayName = site.headline?.trim() || shop.name;
  const tagline = site.tagline?.trim() || "No tagline was generated.";
  const websiteStatus = (site.website_status ?? "draft").toLowerCase();
  const isLive = websiteStatus === "live";
  const publicHost = publicOrigin.replace(/^https?:\/\//, "");

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-dark text-white">
      {/* What this page is, honestly: a summary, not the site. */}
      <div className="shrink-0 border-b border-white/10 bg-dark px-4 py-3 md:px-6">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            {/* h2: the shop's own h1 is in the layout this page sits in. */}
            <h2 className="font-heading text-lg font-semibold text-white">
              Summary of the generated site: {shop.name}
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-white/70">
              <StatusBadge status={websiteStatus} label={isLive ? "Site live" : websiteStatus === "paused" ? "Site paused" : "Site draft"} />
              <span>
                This shows the generated name, tagline, colours, logo and hero image only. It is not the full site: the
                buttons below are part of the picture and do nothing.
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isLive ? (
              <Button asChild variant="secondary" size="sm">
                <a href={`${publicOrigin}/${shop.slug}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden /> Open the real site
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </Button>
            ) : null}
            <Button asChild variant="secondary" size="sm">
              <Link to="/dev/shops">
                <X className="h-4 w-4" aria-hidden />
                Close summary
              </Link>
            </Button>
          </div>
        </div>
        {!isLive ? (
          <p className="mx-auto mt-2 max-w-7xl text-sm text-white/70">
            {websiteStatus === "paused"
              ? "The site is paused, so there is no public page to open until it is resumed."
              : `A draft has no public page yet, so the full site cannot be opened before it goes live. Once activated it is at ${publicHost}/${shop.slug}, and you can pause it again at any time.`}
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={rootStyle} aria-label="Site summary picture">
        <header className="shrink-0 border-b border-white/10 bg-[color:var(--color-brand)]">
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
            <span
              aria-hidden
              className="hidden min-h-12 items-center rounded-lg bg-[color:var(--color-accent)] px-6 text-sm font-semibold text-black md:inline-flex"
            >
              Book Now
            </span>
          </div>
        </header>

        <section className="relative flex min-h-[60vh] flex-1 flex-col justify-end overflow-hidden">
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

          <div className="relative z-10 mx-auto w-full max-w-7xl px-4 pb-16 pt-24 md:px-6 md:pb-24">
            <p className="font-heading text-[clamp(2rem,6vw,3.75rem)] font-bold leading-tight text-white">
              {displayName}
            </p>
            <p className="mt-3 max-w-2xl text-[clamp(1rem,2.8vw,1.5rem)] font-normal text-white/80">{tagline}</p>
            <div className="mt-8 flex flex-wrap gap-4" aria-hidden>
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

      {websiteStatus === "draft" ? (
        <div className="shrink-0 border-t border-white/10 bg-dark px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:px-6">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-end gap-3">
            {activateError && !confirming ? (
              <p role="alert" className="mr-auto text-sm text-red-300">
                {activateError}
              </p>
            ) : null}
            <Button
              type="button"
              disabled={activateFetcher.state !== "idle"}
              onClick={() => {
                setActivateError(null);
                setConfirming(true);
              }}
            >
              {activateFetcher.state !== "idle" ? "Activating…" : "Activate Website"}
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onCancel={() => {
          setConfirming(false);
          setActivateError(null);
        }}
        onConfirm={() => {
          setActivateError(null);
          activateFetcher.submit(
            {},
            { method: "post", action: `/api/shops/${encodeURIComponent(shop.id)}/activate` },
          );
        }}
        title={`Make ${shop.name}'s site live?`}
        confirmLabel="Activate website"
        pendingLabel="Activating…"
        pending={activateFetcher.state !== "idle"}
        error={activateError}
      >
        <p>
          The generated site goes public at {publicHost}/{shop.slug} and customers can book straight away. You have
          seen a summary here, not the full site.
        </p>
        <p>You can pause the site again at any time from the shops list.</p>
      </ConfirmDialog>
    </div>
  );
}
