import { useFetcher, useLoaderData, Link, useNavigate, useRevalidator, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Bot, Copy, ExternalLink, Loader2, Sparkles, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Badge } from "~/components/ui/Badge";
import type { Shop, GenerateSiteActionResult, OnboardResult, DevShopsActionJson } from "~/components/dev-shops/types";
import { E2E_STRIPE_LIST_SHOPS } from "~/components/dev-shops/constants";
import { decidePollAction, toSlug } from "~/components/dev-shops/helpers";
import { StatusBadge } from "~/components/dev-shops/StatusBadge";
import { DeleteShopDialog, type DeleteShopResult } from "~/components/dev-shops/DeleteShopDialog";
import { RatesDialog, type RatesActionResult } from "~/components/dev-shops/RatesDialog";
import { OnboardShopDialog } from "~/components/dev-shops/OnboardShopDialog";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const cookieHeader = request.headers.get("Cookie");
  const url = new URL(request.url);
  const stripeListMock =
    url.searchParams.get("e2e_stripe_shop_list") === "1" ||
    /\be2e_stripe_shop_list=1\b/.test(cookieHeader ?? "");

  if (stripeListMock) {
    return json({ shops: E2E_STRIPE_LIST_SHOPS, apiUrl: env.API_URL });
  }

  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(cookieHeader));

  let shops: Shop[] = [];
  try {
    shops = await api.get<Shop[]>("/api/shops");
  } catch {
    // empty fallback
  }
  return json({ shops, apiUrl: env.API_URL });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));
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
    try {
      const result = await api.post<{ jobId: string; message: string }>(
        `/api/shops/${shopId}/generate-site`,
        body
      );
      return json({
        success: true,
        generateJobId: result.jobId,
        generateShopSlug: shopSlug,
        generateShopId: shopId,
        generateSite: null,
        error: null,
      } satisfies GenerateSiteActionResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Site generation failed";
      return json({ success: false, generateSite: null, error: msg } satisfies GenerateSiteActionResult);
    }
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

export default function DevShops() {
  const { shops } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const filteredShops = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return shops;
    return shops.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        s.slug.toLowerCase().includes(needle) ||
        (s.owner_email || "").toLowerCase().includes(needle)
    );
  }, [shops, q]);

  const activateActFetcher = useFetcher();
  const pauseActFetcher = useFetcher();
  const deleteShopFetcher = useFetcher<DeleteShopResult>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [ratesShop, setRatesShop] = useState<Shop | null>(null);
  const ratesFetcher = useFetcher<RatesActionResult>();
  const [shopToDelete, setShopToDelete] = useState<Shop | null>(null);

  useEffect(() => {
    if (activateActFetcher.state === "idle" && activateActFetcher.data != null) {
      revalidator.revalidate();
    }
  }, [activateActFetcher.state, activateActFetcher.data, revalidator]);

  useEffect(() => {
    if (pauseActFetcher.state === "idle" && pauseActFetcher.data != null) {
      revalidator.revalidate();
    }
  }, [pauseActFetcher.state, pauseActFetcher.data, revalidator]);

  const fetcher = useFetcher<DevShopsActionJson>();
  const generateFetcher = useFetcher<typeof action>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const submitting = fetcher.state !== "idle";
  const result = fetcher.data;
  const generateResult = generateFetcher.data as GenerateSiteActionResult | undefined;
  const onboard = result && "result" in result ? result : undefined;
  const inviteToken = onboard?.success ? onboard.result?.invite_token : null;
  const checkoutUrl = onboard?.success ? onboard.result?.checkout_url : null;
  const generatingShopId = generateFetcher.formData?.get("shopId")?.toString();

  const [devGenJob, setDevGenJob] = useState<{
    id: string;
    slug: string;
    shopId: string;
  } | null>(null);
  const [devGenDoneSlug, setDevGenDoneSlug] = useState<string | null>(null);
  // A live or paused site's regeneration waits for review on the shop's page
  // instead of replacing the site (migration 049).
  const [devGenReviewShopId, setDevGenReviewShopId] = useState<string | null>(null);

  useEffect(() => {
    if (devGenJob && !shops.some((s) => s.id === devGenJob.shopId)) {
      setDevGenJob(null);
    }
  }, [devGenJob, shops]);

  useEffect(() => {
    if (deleteShopFetcher.state !== "idle" || !deleteShopFetcher.data) return;
    const d = deleteShopFetcher.data;
    if (!d.success) return;

    const deletedId =
      shopToDelete?.id ?? (typeof d.data?.id === "string" ? d.data.id : undefined);
    if (deletedId && devGenJob?.shopId === deletedId) setDevGenJob(null);

    setShopToDelete(null);
    queueMicrotask(() => revalidator.revalidate());
  }, [
    deleteShopFetcher.state,
    deleteShopFetcher.data,
    revalidator,
    shopToDelete,
    devGenJob?.shopId,
  ]);

  useEffect(() => {
    const d = generateResult;
    if (d?.success && d.generateJobId && d.generateShopSlug && d.generateShopId) {
      setDevGenJob({
        id: d.generateJobId,
        slug: d.generateShopSlug,
        shopId: d.generateShopId,
      });
    }
  }, [generateResult]);

  useEffect(() => {
    if (!devGenJob) return;
    let cancelled = false;
    const startedAt = Date.now();
    let failures = 0;
    let iv: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (iv !== undefined) {
        clearInterval(iv);
        iv = undefined;
      }
    };
    const tick = async () => {
      let data:
        | { status?: string; stage?: string; shopSlug?: string; error?: string; outcome?: string }
        | undefined;
      try {
        const r = await fetch(`/api/jobs/${devGenJob.id}/status`, { cache: "no-store" });
        const j = (await r.json()) as {
          success?: boolean;
          data?: { status?: string; stage?: string; shopSlug?: string; error?: string; outcome?: string };
        };
        if (cancelled) return;
        if (j.success && j.data) data = j.data;
      } catch {
        /* network/parse failure → counts as a failed poll below */
      }
      if (cancelled) return;

      const ok = data !== undefined;
      failures = ok ? 0 : failures + 1;
      const decision = decidePollAction({
        ok,
        status: data?.status ?? "",
        stage: data?.stage ?? "",
        elapsedMs: Date.now() - startedAt,
        consecutiveFailures: failures,
      });

      switch (decision.kind) {
        case "terminal":
          stop();
          if ((data?.status ?? "") === "failed") {
            console.warn("[dev/shops] generation failed", data?.error);
          } else if (data?.outcome === "candidate") {
            setDevGenDoneSlug(null);
            setDevGenReviewShopId(devGenJob.shopId);
          } else {
            setDevGenReviewShopId(null);
            setDevGenDoneSlug(data?.shopSlug || devGenJob.slug);
          }
          setDevGenJob(null);
          break;
        case "stalled":
        case "give-up":
          // Same failure floor as the regenerate poller: a job the pipeline
          // orphaned never reaches a terminal state, so stop rather than poll
          // forever behind the "generation in progress" banner.
          console.warn("[dev/shops] generation stalled:", decision.message);
          stop();
          setDevGenJob(null);
          break;
        // "update" | "keep-going": keep polling.
      }
    };
    void tick();
    iv = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [devGenJob]);
  const inviteUrl = inviteToken
    ? `https://pivotparlor.com/invite/${inviteToken}`
    : null;

  // Reset form state when dialog closes
  useEffect(() => {
    if (!dialogOpen) {
      setSlug("");
      setSlugManuallyEdited(false);
      setCopied(false);
    }
  }, [dialogOpen]);

  // Close dialog automatically after a successful submission, but keep it open
  // to display the invite link — so we leave it open and show the success state.

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!slugManuallyEdited) {
      setSlug(toSlug(e.target.value));
    }
  }

  function copyInviteUrl() {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copyPaymentUrl(url: string) {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }


  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold text-white">Shops</h1>
        <OnboardShopDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          fetcher={fetcher}
          errorMessage={result?.error ?? null}
          submitting={submitting}
          checkoutUrl={checkoutUrl ?? null}
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
        />
      </div>

      <DeleteShopDialog
        shop={shopToDelete}
        onClose={() => setShopToDelete(null)}
        fetcher={deleteShopFetcher}
      />

      <RatesDialog
        shop={ratesShop}
        onClose={() => setRatesShop(null)}
        fetcher={ratesFetcher}
      />

      <div className="mb-4">
        <Input
          type="search"
          placeholder="Search by name, slug, or owner email…"
          value={q}
          onChange={(e) => {
            const v = e.target.value;
            setSearchParams(v ? { q: v } : {}, { replace: true });
          }}
          className="max-w-xl"
          aria-label="Filter shops"
        />
      </div>

      {/* Generate site success message */}
      {devGenDoneSlug && (
        <div className="mb-4 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
          Site generated.{" "}
          <a
            href={`https://pivotparlor.com/${devGenDoneSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold hover:underline"
          >
            View Site →
          </a>
        </div>
      )}

      {devGenReviewShopId && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-white/85"
        >
          New version ready. The live site has not changed.{" "}
          <Link to={`/dev/shops/${devGenReviewShopId}`} className="text-gold hover:underline">
            Review it on the shop&apos;s page
          </Link>
        </div>
      )}

      {devGenJob && (
        <div className="mb-4 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-gold">
          Site generation in progress… This page will update when the pipeline finishes (research → build → audit).
        </div>
      )}

      {/* Generate site error */}
      {generateResult?.success === false && generateResult?.error && (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {generateResult.error}
        </div>
      )}

      {/* ── Shops table ── */}
      <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              {["#", "Name", "Owner", "Type", "AI Model", "Status", "Actions"].map((h) => (
                <th
                  key={h}
                  className="px-4 py-3 text-left text-xs font-semibold text-white/60 uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {shops.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-white/60">
                  No shops yet. Create your first shop above.
                </td>
              </tr>
            ) : filteredShops.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-white/60">
                  No shops match your search.
                </td>
              </tr>
            ) : (
              filteredShops.map((shop) => {
                const ws = (shop.website_status ?? "draft").toLowerCase();
                const isActiveShop = shop.status === "active";
                const showDraftTools = isActiveShop && shop.has_site && ws === "draft";

                return (
                  <Fragment key={shop.id}>
                    <tr className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 text-white/50">{shop.shop_number}</td>
                      <td className="px-4 py-3">
                        <span className="font-medium text-white">{shop.name}</span>
                        <span className="ml-2 text-xs text-white/50">/{shop.slug}</span>
                      </td>
                      <td className="px-4 py-3 text-white/60">{shop.owner_email}</td>
                      <td className="px-4 py-3 text-white/60 capitalize">
                        {shop.type.replace(/_/g, " ")}
                      </td>
                      <td className="px-4 py-3">
                        {shop.ai_model ? (
                          <Badge
                            variant={shop.ai_model.includes("claude") ? "anthropic" : "google"}
                          >
                            {shop.ai_model.replace(/-/g, " ")}
                          </Badge>
                        ) : (
                          <span className="text-white/50">Not set</span>
                        )}
                      </td>
                      <td className="px-4 py-3">{<StatusBadge shop={shop} />}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            {shop.stripe_payment_status === "unpaid" && shop.stripe_checkout_url && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => copyPaymentUrl(shop.stripe_checkout_url!)}
                              >
                                <Copy className="h-3.5 w-3.5 mr-1" /> Copy Payment Link
                              </Button>
                            )}
                            {ws === "live" && (
                              <Badge variant="success" className="uppercase">
                                LIVE
                              </Badge>
                            )}
                            {ws === "paused" && (
                              <Badge variant="warning" className="uppercase">
                                PAUSED
                              </Badge>
                            )}
                            {isActiveShop && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => navigate(`/dev/shops/${shop.id}`)}
                              >
                                {ws === "live" || ws === "paused" ? "Edit" : "Regenerate"}
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setRatesShop(shop)}
                              title="Commission rates (services vs retail)"
                            >
                              Rates
                            </Button>
                            {showDraftTools && (
                              <>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => navigate(`/dev/shops/${shop.id}/preview`)}
                                >
                                  Preview
                                </Button>
                                <activateActFetcher.Form
                                  method="post"
                                  action={`/api/shops/${shop.id}/activate`}
                                  className="inline"
                                >
                                  <Button type="submit" size="sm" className="bg-emerald-700 hover:bg-emerald-600">
                                    Activate Website
                                  </Button>
                                </activateActFetcher.Form>
                              </>
                            )}
                            {ws === "live" && (
                              <>
                                <pauseActFetcher.Form
                                  method="post"
                                  action={`/api/shops/${shop.id}/pause`}
                                  className="inline"
                                >
                                  <Button type="submit" variant="ghost" size="sm">
                                    Pause
                                  </Button>
                                </pauseActFetcher.Form>
                                <a
                                  href={`https://pivot-parlor-web.pages.dev/${shop.slug}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Button variant="ghost" size="sm">
                                    <ExternalLink className="h-3.5 w-3.5 mr-1" /> View Website
                                  </Button>
                                </a>
                              </>
                            )}
                            {ws === "paused" && (
                              <>
                                <activateActFetcher.Form
                                  method="post"
                                  action={`/api/shops/${shop.id}/activate`}
                                  className="inline"
                                >
                                  <Button type="submit" variant="ghost" size="sm">
                                    Resume
                                  </Button>
                                </activateActFetcher.Form>
                                <a
                                  href={`https://pivot-parlor-web.pages.dev/${shop.slug}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Button variant="ghost" size="sm">
                                    <ExternalLink className="h-3.5 w-3.5 mr-1" /> View Website
                                  </Button>
                                </a>
                              </>
                            )}
                            {isActiveShop && !shop.has_site && (
                              <generateFetcher.Form method="post" className="flex items-center gap-2">
                                <input type="hidden" name="_action" value="generate-site" />
                                <input type="hidden" name="shopId" value={shop.id} />
                                <input type="hidden" name="shopSlug" value={shop.slug} />
                                <select
                                  name="template"
                                  className="rounded border border-white/20 bg-white/5 px-2 py-1 text-xs text-white"
                                  title="Template (for testing)"
                                >
                                  <option value="">Auto</option>
                                  <option value="minimal">Minimal</option>
                                  <option value="luxury">Luxury</option>
                                  <option value="vibrant">Vibrant</option>
                                  <option value="editorial">Editorial</option>
                                  <option value="classic">Classic</option>
                                  <option value="fresh">Fresh</option>
                                </select>
                                <select
                                  name="composer"
                                  className="rounded border border-white/20 bg-white/5 px-2 py-1 text-xs text-white"
                                  title="Site composer"
                                >
                                  <option value="ai">AI design director</option>
                                  <option value="seed">Deterministic seed</option>
                                </select>
                                <Button
                                  type="submit"
                                  variant="ghost"
                                  size="sm"
                                  disabled={
                                    generateFetcher.state !== "idle" || devGenJob?.shopId === shop.id
                                  }
                                >
                                  {generatingShopId === shop.id || devGenJob?.shopId === shop.id ? (
                                    <>
                                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Generating…
                                    </>
                                  ) : (
                                    <>
                                      <Sparkles className="h-3.5 w-3.5 mr-1" /> Generate Site
                                    </>
                                  )}
                                </Button>
                              </generateFetcher.Form>
                            )}
                            <Button asChild variant="ghost" size="sm">
                              <Link to={`/dev/ai-deploy?shopId=${shop.id}`}>
                                <Bot className="h-3.5 w-3.5 mr-1" /> AI Deploy
                              </Link>
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                              onClick={() => setShopToDelete(shop)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1" />
                              Delete
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
