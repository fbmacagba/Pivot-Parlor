import { useFetcher, useLoaderData, useSearchParams, Link, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import type {
  Shop,
  GenerateSiteActionResult,
  OnboardActionJson,
  OnboardResult,
  DevShopsActionJson,
} from "~/components/dev-shops/types";
import {
  filterAndSortShops,
  readGenerateSiteReply,
  SHOP_STAGES,
  toSlug,
  type ShopSort,
  type ShopStage,
} from "~/components/dev-shops/helpers";
import { DeleteShopDialog } from "~/components/dev-shops/DeleteShopDialog";
import { RatesDialog, type RatesActionResult } from "~/components/dev-shops/RatesDialog";
import { OnboardShopDialog } from "~/components/dev-shops/OnboardShopDialog";
import { ShopRow, SHOP_ROW_GRID, type SiteIntent } from "~/components/dev-shops/ShopRow";
import { forgetJob, recallJob, rememberJob, useGenerationJob } from "~/components/dev-shops/useGenerationJob";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { useFetcherResult } from "~/lib/useFetcherResult";

export const meta = () => pageTitle("Shops");

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

/**
 * Headers that ask the API for its E2E fixtures. The API answers with them
 * only where fixtures are switched on (E2E_FIXTURES, staging), so this page
 * holds no fixture of its own: in production the request is an ordinary one.
 */
function e2eHeadersFor(request: Request): Record<string, string> {
  const headers = { ...apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")) };
  if (new URL(request.url).searchParams.get("e2e_stripe_shop_list") === "1") {
    headers["X-E2E-Test-Mock-Stripe-List"] = "1";
  }
  return headers;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token, e2eHeadersFor(request));

  let shops: Shop[] = [];
  let loadError = false;
  try {
    const rows = await api.get<Shop[]>("/api/shops");
    if (!Array.isArray(rows)) throw new Error("Unexpected shops answer");
    shops = rows;
  } catch {
    loadError = true;
  }
  // Shop sites, invite links and this dashboard share one origin, so every
  // public link is built from the address this request came in on.
  return json({ shops, loadError, publicOrigin: new URL(request.url).origin });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token, e2eHeadersFor(request));
  const form = await readFormData(request);
  if (!form) return json({ success: false, error: UNREADABLE_FORM }, { status: 400 });

  const actionType = form.get("_action");

  if (actionType === "update-rates") {
    const shopId = form.get("shopId")?.toString();
    const commissionPct = Number(form.get("commission_percent"));
    const retailPct = Number(form.get("retail_commission_percent"));
    const valid = (v: number) => Number.isFinite(v) && v >= 0 && v <= 100;
    if (!shopId || !valid(commissionPct) || !valid(retailPct)) {
      return json({ success: false, ratesUpdated: false, error: "Rates must be between 0 and 100 percent" });
    }
    try {
      await api.patch(`/api/shops/${shopId}`, {
        commission_rate: commissionPct / 100,
        retail_commission_rate: retailPct / 100,
      });
      return json({ success: true, ratesUpdated: true, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update rates";
      return json({ success: false, ratesUpdated: false, error: msg });
    }
  }

  if (actionType === "generate-site") {
    const shopId = form.get("shopId")?.toString();
    const shopSlug = form.get("shopSlug")?.toString();
    const template = form.get("template")?.toString();
    if (!shopId) {
      return json({ success: false, generateSite: null, error: "Missing shopId" } satisfies GenerateSiteActionResult);
    }
    const body: Record<string, unknown> = {};
    if (template) body.template = template;
    const composer = form.get("composer")?.toString();
    if (composer === "ai" || composer === "seed") body.composer = composer;
    // The shop's own page regenerates through this action too, with its
    // palette and "reuse the current images" choice.
    if (form.get("skip_images") === "1") body.skip_images = true;
    const colorPrimary = form.get("color_primary")?.toString().trim();
    const colorAccent = form.get("color_accent")?.toString().trim();
    if (colorPrimary && colorAccent) {
      body.color_primary = colorPrimary;
      body.color_accent = colorAccent;
    }
    // A direct call rather than the API client: the client keeps only an
    // error's message, and a 409 here carries the id of the run already going,
    // which the page follows instead of reporting an error.
    let reply: ReturnType<typeof readGenerateSiteReply>;
    try {
      const res = await fetch(`${env.API_URL}/api/shops/${encodeURIComponent(shopId)}/generate-site`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...e2eHeadersFor(request),
        },
        body: JSON.stringify(body),
      });
      reply = readGenerateSiteReply(res.status, await res.json().catch(() => null));
    } catch {
      reply = { error: "Could not reach the server. Please try again." };
    }
    if ("error" in reply) {
      return json({
        success: false,
        generateShopId: shopId,
        generateSite: null,
        error: reply.error,
      } satisfies GenerateSiteActionResult);
    }
    return json({
      success: true,
      generateJobId: reply.jobId,
      adopted: reply.adopted,
      generateShopSlug: shopSlug,
      generateShopId: shopId,
      generateSite: null,
      error: null,
    } satisfies GenerateSiteActionResult);
  }

  try {
    const result = await api.post<OnboardResult>("/api/shops", {
      name: form.get("name"),
      slug: form.get("slug") || undefined,
      owner_email: form.get("owner_email"),
      type: form.get("type") || undefined,
      plan: form.get("plan") || undefined,
    });
    return json({ success: true, result, error: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create shop";
    return json({ success: false, result: null, error: msg });
  }
}

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev" homeLabel="Back to overview" />;
}

const SORTS: { value: ShopSort; label: string }[] = [
  { value: "number", label: "Shop number" },
  { value: "name", label: "Name" },
  { value: "newest", label: "Newest first" },
];

type SiteReply = { ok?: boolean; success?: boolean; error?: string };

const SITE_COPY: Record<SiteIntent, { confirm: string; pending: string; failed: string }> = {
  pause: { confirm: "Pause site", pending: "Pausing…", failed: "The site could not be paused. It is still live." },
  activate: {
    confirm: "Activate website",
    pending: "Activating…",
    failed: "The site could not be made live. It is still a draft.",
  },
  resume: { confirm: "Resume site", pending: "Resuming…", failed: "The site could not be resumed. It is still paused." },
};

export default function DevShops() {
  const { shops, loadError, publicOrigin } = useLoaderData<typeof loader>();

  // ── Search, status and sort ──────────────────────────────────────────────
  // All three filter in memory. The address bar is kept in step without a
  // navigation, so typing never reruns the loader; a link with ?q= (or
  // ?status=, ?sort=) still opens the list already filtered.
  const [initialParams] = useSearchParams();
  const [query, setQuery] = useState(initialParams.get("q") ?? "");
  const [stage, setStage] = useState<ShopStage | "">(() => {
    const wanted = initialParams.get("status");
    return SHOP_STAGES.some((s) => s.value === wanted) ? (wanted as ShopStage) : "";
  });
  const [sort, setSort] = useState<ShopSort>(() => {
    const wanted = initialParams.get("sort");
    return SORTS.some((s) => s.value === wanted) ? (wanted as ShopSort) : "number";
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const put = (key: string, value: string) => (value ? params.set(key, value) : params.delete(key));
    put("q", query.trim() ? query : "");
    put("status", stage);
    put("sort", sort === "number" ? "" : sort);
    const qs = params.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      // The router's own history entry is kept; only the address changes.
      window.history.replaceState(window.history.state, "", next);
    }
  }, [query, stage, sort]);

  const filteredShops = useMemo(
    () => filterAndSortShops(shops, { query, stage, sort }),
    [shops, query, stage, sort],
  );
  const filtering = query.trim() !== "" || stage !== "";

  // ── Rates and delete ─────────────────────────────────────────────────────
  const [ratesShop, setRatesShop] = useState<Shop | null>(null);
  const ratesFetcher = useFetcher<RatesActionResult>();
  const [shopToDelete, setShopToDelete] = useState<Shop | null>(null);

  // ── Activate, pause, resume: confirmed first, one at a time ──────────────
  const siteFetcher = useFetcher<SiteReply>();
  const [siteAction, setSiteAction] = useState<{ shop: Shop; intent: SiteIntent } | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const siteBusy = siteFetcher.state !== "idle";
  useFetcherResult(siteFetcher, (reply) => {
    if (reply.ok === true || reply.success === true) {
      setSiteAction(null);
      setSiteError(null);
    } else {
      const fallback = siteAction ? SITE_COPY[siteAction.intent].failed : "The change could not be made.";
      setSiteError(reply.error?.trim() ? `${fallback} (${reply.error.trim()})` : `${fallback} Please try again.`);
    }
  });

  // ── Onboarding ───────────────────────────────────────────────────────────
  const fetcher = useFetcher<DevShopsActionJson>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // The fetcher keeps its last answer for good; what the dialog shows is this
  // copy, set once per finished submission and cleared when the dialog closes,
  // so opening it again always starts with an empty form.
  const [onboardOutcome, setOnboardOutcome] = useState<OnboardActionJson | null>(null);
  useFetcherResult(fetcher, (answer) => {
    if ("result" in answer) setOnboardOutcome(answer as OnboardActionJson);
  });

  const submitting = fetcher.state !== "idle";
  const onboarded: OnboardResult | null = onboardOutcome?.success ? onboardOutcome.result : null;
  const inviteToken = onboarded?.invite_token ?? null;
  const checkoutUrl = onboarded?.checkout_url ?? null;

  // ── First-time generation ────────────────────────────────────────────────
  const generateFetcher = useFetcher<GenerateSiteActionResult>();
  const startingShopId =
    generateFetcher.state !== "idle" ? (generateFetcher.formData?.get("shopId")?.toString() ?? null) : null;
  const [devGenJob, setDevGenJob] = useState<{
    id: string;
    slug: string;
    shopId: string;
  } | null>(null);
  const [devGenDoneSlug, setDevGenDoneSlug] = useState<string | null>(null);
  // A live or paused site's regeneration waits for review on the shop's page
  // instead of replacing the site (migration 049).
  const [devGenReviewShopId, setDevGenReviewShopId] = useState<string | null>(null);
  // Why a shop's generation did not finish, by shop id: shown on its row.
  const [genFailures, setGenFailures] = useState<Record<string, string>>({});
  const [copiedPaymentFor, setCopiedPaymentFor] = useState<string | null>(null);

  useEffect(() => {
    if (devGenJob && !shops.some((s) => s.id === devGenJob.shopId)) {
      setDevGenJob(null);
    }
  }, [devGenJob, shops]);

  // A run started before a reload, or in another tab, is picked up again.
  useEffect(() => {
    if (devGenJob) return;
    for (const s of shops) {
      const jobId = recallJob(s.id);
      if (jobId) {
        setDevGenJob({ id: jobId, slug: s.slug, shopId: s.id });
        return;
      }
    }
  }, [devGenJob, shops]);

  useFetcherResult(generateFetcher, (d) => {
    const shopId = d.generateShopId;
    if (d.success && d.generateJobId && d.generateShopSlug && shopId) {
      setGenFailures((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== shopId)));
      setDevGenDoneSlug(null);
      setDevGenReviewShopId(null);
      rememberJob(shopId, d.generateJobId);
      setDevGenJob({ id: d.generateJobId, slug: d.generateShopSlug, shopId });
    } else if (shopId) {
      setGenFailures((prev) => ({ ...prev, [shopId]: d.error?.trim() || "The run could not be started." }));
    }
  });

  useGenerationJob(devGenJob?.id ?? null, {
    onEnd: (end) => {
      const job = devGenJob;
      if (!job) return;
      forgetJob(job.shopId);
      setDevGenJob(null);
      if (end.kind === "failed") {
        setGenFailures((prev) => ({ ...prev, [job.shopId]: end.message }));
      } else if (end.snapshot.outcome === "candidate") {
        setDevGenDoneSlug(null);
        setDevGenReviewShopId(job.shopId);
      } else {
        setDevGenReviewShopId(null);
        setDevGenDoneSlug(end.snapshot.shopSlug || job.slug);
      }
    },
  });

  const inviteUrl = inviteToken ? `${publicOrigin}/invite/${inviteToken}` : null;

  // Reset form state when dialog closes
  useEffect(() => {
    if (!dialogOpen) {
      setSlug("");
      setSlugManuallyEdited(false);
      setCopied(false);
      setOnboardOutcome(null);
    }
  }, [dialogOpen]);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!slugManuallyEdited) {
      setSlug(toSlug(e.target.value));
    }
  }

  function copyText(text: string, done: () => void) {
    navigator.clipboard?.writeText(text).then(done, () => {
      /* clipboard refused (permissions): the link is still on screen to copy by hand */
    });
  }

  function copyInviteUrl() {
    if (!inviteUrl) return;
    copyText(inviteUrl, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copyPaymentUrl(url: string) {
    copyText(url, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copyRowPaymentUrl(shopId: string, url: string) {
    copyText(url, () => {
      setCopiedPaymentFor(shopId);
      setTimeout(() => setCopiedPaymentFor((current) => (current === shopId ? null : current)), 2000);
    });
  }

  const siteShop = siteAction?.shop;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-bold text-white">Shops</h1>
        <OnboardShopDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          fetcher={fetcher}
          errorMessage={onboardOutcome && !onboardOutcome.success ? onboardOutcome.error : null}
          submitting={submitting}
          checkoutUrl={checkoutUrl}
          inviteUrl={inviteUrl}
          copied={copied}
          onCopyInvite={copyInviteUrl}
          onCopyPayment={copyPaymentUrl}
          slug={slug}
          onSlugChange={(value) => {
            setSlug(value);
            setSlugManuallyEdited(true);
          }}
          onNameChange={handleNameChange}
          nameRef={nameRef}
          publicHost={publicOrigin.replace(/^https?:\/\//, "")}
        />
      </div>

      <DeleteShopDialog
        shop={shopToDelete}
        onClose={() => setShopToDelete(null)}
        onDeleted={(shopId) => {
          forgetJob(shopId);
          if (devGenJob?.shopId === shopId) setDevGenJob(null);
        }}
      />

      <RatesDialog
        shop={ratesShop}
        onClose={() => setRatesShop(null)}
        fetcher={ratesFetcher}
      />

      <ConfirmDialog
        open={siteAction !== null}
        onCancel={() => {
          setSiteAction(null);
          setSiteError(null);
        }}
        onConfirm={() => {
          if (!siteAction) return;
          setSiteError(null);
          siteFetcher.submit(
            {},
            {
              method: "post",
              action: `/api/shops/${encodeURIComponent(siteAction.shop.id)}/${siteAction.intent === "pause" ? "pause" : "activate"}`,
            },
          );
        }}
        title={
          !siteAction
            ? "Change site"
            : siteAction.intent === "pause"
              ? `Pause ${siteShop?.name}'s site?`
              : siteAction.intent === "activate"
                ? `Make ${siteShop?.name}'s site live?`
                : `Resume ${siteShop?.name}'s site?`
        }
        confirmLabel={siteAction ? SITE_COPY[siteAction.intent].confirm : "Confirm"}
        pendingLabel={siteAction ? SITE_COPY[siteAction.intent].pending : undefined}
        destructive={siteAction?.intent === "pause"}
        pending={siteBusy}
        error={siteError}
      >
        {siteAction?.intent === "pause" && (
          <p>
            Take {siteShop?.name}&apos;s site offline? Customers will not be able to book until you resume it.
          </p>
        )}
        {siteAction?.intent === "activate" && (
          <p>
            The generated site goes public at {publicOrigin.replace(/^https?:\/\//, "")}/{siteShop?.slug} and customers
            can book straight away. You can pause it again at any time.
          </p>
        )}
        {siteAction?.intent === "resume" && (
          <p>The site goes back online and customers can book again. You can pause it again at any time.</p>
        )}
      </ConfirmDialog>

      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_12rem] sm:items-end">
        <Input
          type="search"
          label="Search shops"
          hideLabel
          placeholder="Search by name, slug, or owner email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select label="Status" value={stage} onChange={(e) => setStage(e.target.value as ShopStage | "")}>
          <option value="">Any status</option>
          {SHOP_STAGES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as ShopSort)}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>

      {/* Generate site success message */}
      {devGenDoneSlug && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300"
        >
          Site generated.{" "}
          <a
            href={`${publicOrigin}/${devGenDoneSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="tap-target inline-flex items-center text-gold hover:underline"
          >
            View Site<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>
      )}

      {devGenReviewShopId && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-white/80"
        >
          New version ready. The live site has not changed.{" "}
          <Link
            to={`/dev/shops/${devGenReviewShopId}`}
            className="tap-target inline-flex items-center text-gold hover:underline"
          >
            Review it on the shop&apos;s page
          </Link>
        </div>
      )}

      {devGenJob && (
        <div role="status" className="mb-4 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-white/80">
          Site generation in progress for{" "}
          <span className="font-medium text-white">
            {shops.find((s) => s.id === devGenJob.shopId)?.name ?? devGenJob.slug}
          </span>
          . This page updates when it finishes (research, then text and images, then assembly).
        </div>
      )}

      {/* ── Shops: a card each on a phone, a grid row from lg ── */}
      {loadError ? (
        <LoadError what="the shops list" />
      ) : shops.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-dark-100 px-4 py-8 text-center text-sm text-white/60">
          No shops yet. Use New Shop to onboard the first one.
        </p>
      ) : filteredShops.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-dark-100 px-4 py-8 text-center text-sm text-white/60">
          <p>No shops match your search.</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => {
              setQuery("");
              setStage("");
            }}
          >
            Clear search and status
          </Button>
        </div>
      ) : (
        <>
          <p className="mb-2 text-sm text-white/60" role="status">
            {filtering
              ? `Showing ${filteredShops.length} of ${shops.length} shops`
              : `${shops.length} ${shops.length === 1 ? "shop" : "shops"}`}
          </p>
          <div className="lg:rounded-xl lg:border lg:border-white/10 lg:bg-dark-100">
            <div
              aria-hidden
              className={`hidden border-b border-white/10 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-white/60 ${SHOP_ROW_GRID}`}
            >
              <span>Shop</span>
              <span>Type and model</span>
              <span>Status</span>
              <span>Actions</span>
            </div>
            <ul aria-label="Shops" className="space-y-3 lg:space-y-0 lg:divide-y lg:divide-white/5">
              {filteredShops.map((shop) => (
                <ShopRow
                  key={shop.id}
                  shop={shop}
                  publicOrigin={publicOrigin}
                  generating={startingShopId === shop.id || devGenJob?.shopId === shop.id}
                  generateLocked={generateFetcher.state !== "idle" || devGenJob !== null}
                  generationFailure={genFailures[shop.id] ?? null}
                  pendingSiteIntent={siteBusy && siteAction?.shop.id === shop.id ? siteAction.intent : null}
                  paymentCopied={copiedPaymentFor === shop.id}
                  onCopyPaymentLink={(url) => copyRowPaymentUrl(shop.id, url)}
                  onSiteIntent={(intent) => {
                    setSiteError(null);
                    setSiteAction({ shop, intent });
                  }}
                  onGenerate={({ template, composer }) =>
                    generateFetcher.submit(
                      { _action: "generate-site", shopId: shop.id, shopSlug: shop.slug, template, composer },
                      { method: "post", action: "/dev/shops?index" },
                    )
                  }
                  onRates={() => setRatesShop(shop)}
                  onDelete={() => setShopToDelete(shop)}
                />
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
