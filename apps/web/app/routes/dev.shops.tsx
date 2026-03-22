import { useFetcher, useLoaderData, Link, useNavigate, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Bot, Copy, ExternalLink, Loader2, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DevGenerationPrefs } from "./dev.shops.$shopId";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Badge } from "~/components/ui/Badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/Dialog";

interface Shop {
  id: string;
  shop_number: number;
  name: string;
  slug: string;
  type: string;
  owner_name: string;
  owner_email: string;
  bookings_count?: number;
  revenue?: number;
  commission?: number;
  ai_model?: string;
  is_active: number;
  status: string;
  plan: string;
  has_site?: number | null;
  stripe_payment_status?: string;
  stripe_checkout_url?: string | null;
}

/** SSR-only mock for Playwright (page.route cannot intercept loader fetches to API_URL). */
const E2E_STRIPE_LIST_SHOPS: Shop[] = [
  {
    id: "e2e-mock-unpaid",
    shop_number: 999,
    name: "E2E Unpaid Shop",
    slug: "e2e-unpaid-999",
    type: "beauty_parlor",
    owner_name: "",
    owner_email: "e2e@example.com",
    is_active: 0,
    status: "awaiting_payment",
    plan: "standard",
    has_site: null,
    stripe_payment_status: "unpaid",
    stripe_checkout_url: "https://checkout.stripe.com/e2e-mock-session",
  },
];

interface GenerateSiteActionResult {
  success: boolean;
  generateJobId?: string;
  generateShopSlug?: string;
  generateShopId?: string;
  generateSite?: { template: string; slug: string } | null;
  error?: string | null;
}

interface OnboardResult {
  shop: { id: string; slug: string; name: string };
  invite_token?: string;
  checkout_url?: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
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
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));
  const form = await request.formData();

  const actionType = form.get("_action");

  if (actionType === "generate-site") {
    const shopId = form.get("shopId")?.toString();
    const shopSlug = form.get("shopSlug")?.toString();
    const template = form.get("template")?.toString();
    if (!shopId) {
      return json({ success: false, generateSite: null, error: "Missing shopId" } satisfies GenerateSiteActionResult);
    }
    const body: Record<string, unknown> = {};
    if (template) body.template = template;
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

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export default function DevShops() {
  const { shops } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
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

  const [regenerateBusyId, setRegenerateBusyId] = useState<string | null>(null);
  const [regenerateErrors, setRegenerateErrors] = useState<Record<string, string>>({});

  const handleRegenerateSite = useCallback(
    async (shopId: string) => {
      setRegenerateErrors((prev) => {
        const next = { ...prev };
        delete next[shopId];
        return next;
      });
      setRegenerateBusyId(shopId);
      try {
        const prefsRes = await fetch(`/api/shops/${shopId}/generation-prefs`, {
          credentials: "include",
        });
        const prefsJson = (await prefsRes.json()) as {
          success?: boolean;
          data?: DevGenerationPrefs;
          error?: string;
        };
        if (!prefsRes.ok || prefsJson.success === false) {
          throw new Error(
            prefsJson.error ?? `Failed to load generation prefs (${prefsRes.status})`
          );
        }
        const prefs = prefsJson.data ?? {
          template: "minimal",
          design_notes: null,
          color_primary: null,
          color_accent: null,
        };

        const body: Record<string, unknown> = {
          template: prefs.template?.trim() || "minimal",
        };
        if (prefs.design_notes?.trim()) body.design_notes = prefs.design_notes.trim();
        if (prefs.color_primary?.trim()) body.color_primary = prefs.color_primary.trim();
        if (prefs.color_accent?.trim()) body.color_accent = prefs.color_accent.trim();

        const genRes = await fetch(`/api/shops/${shopId}/generate-site`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const genJson = (await genRes.json()) as {
          success?: boolean;
          data?: { jobId?: string; message?: string };
          error?: string;
        };
        if (!genRes.ok || genJson.success === false) {
          throw new Error(genJson.error ?? `Site generation failed (${genRes.status})`);
        }
        const jobId = genJson.data?.jobId;
        if (!jobId) throw new Error("No job id returned");
        navigate(`/dev/shops/${shopId}/generation/${jobId}`);
      } catch (e) {
        setRegenerateErrors((prev) => ({
          ...prev,
          [shopId]: e instanceof Error ? e.message : "Something went wrong",
        }));
      } finally {
        setRegenerateBusyId(null);
      }
    },
    [navigate]
  );

  type OnboardActionJson =
    | { success: true; result: OnboardResult; error: null }
    | { success: false; result: null; error: string };
  type DevShopsActionJson = OnboardActionJson | GenerateSiteActionResult;

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
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${devGenJob.id}/status`);
        const j = (await r.json()) as {
          success?: boolean;
          data?: { status?: string; stage?: string; shopSlug?: string; error?: string };
        };
        if (cancelled) return;
        if (!j.success || !j.data) return;
        const { status, stage, shopSlug, error } = j.data;
        if (status === "failed") {
          console.warn("[dev/shops] generation failed", error);
          setDevGenJob(null);
          return;
        }
        if (stage === "done" || status === "complete") {
          setDevGenDoneSlug(shopSlug || devGenJob.slug);
          setDevGenJob(null);
        }
      } catch {
        /* ignore */
      }
    };
    void tick();
    const iv = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
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

  const statusBadge = (shop: Shop) => {
    if (shop.status === "active") return <Badge variant="success">Active</Badge>;
    if (shop.status === "suspended") return <Badge variant="error">Suspended</Badge>;
    if (shop.status === "awaiting_payment" || shop.stripe_payment_status === "unpaid") {
      return <Badge variant="warning">Awaiting Payment</Badge>;
    }
    if (shop.stripe_payment_status === "paid") return <Badge variant="success">Paid</Badge>;
    return <Badge variant="warning">Pending</Badge>;
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold text-white">Shops</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> New Shop
            </Button>
          </DialogTrigger>

          <DialogContent>
            <DialogHeader>
              <DialogTitle>Onboard new shop</DialogTitle>
            </DialogHeader>

            {/* ── Success state — show payment link or invite link ── */}
            {checkoutUrl ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
                  Shop created! Send the £100 payment link to the owner. Once paid, the invite link will activate.
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="mb-2 text-xs font-medium text-white/50 uppercase tracking-wider">
                    Payment link (£100)
                  </p>
                  <p className="break-all text-sm text-white font-mono">{checkoutUrl}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="flex-1"
                    onClick={() => copyPaymentUrl(checkoutUrl)}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    {copied ? "Copied!" : "Copy Payment Link"}
                  </Button>
                  <a
                    href={checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1"
                  >
                    <Button type="button" variant="ghost" size="sm" className="w-full">
                      <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                    </Button>
                  </a>
                </div>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => setDialogOpen(false)}
                >
                  Done
                </Button>
              </div>
            ) : inviteUrl ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
                  Shop created! Send the invite link to the owner so they can set
                  their password and activate the shop.
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="mb-2 text-xs font-medium text-white/50 uppercase tracking-wider">
                    Invite link
                  </p>
                  <p className="break-all text-sm text-white font-mono">{inviteUrl}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="flex-1"
                    onClick={copyInviteUrl}
                  >
                    <Copy className="h-3.5 w-3.5 mr-1" />
                    {copied ? "Copied!" : "Copy link"}
                  </Button>
                  <a
                    href={inviteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1"
                  >
                    <Button type="button" variant="ghost" size="sm" className="w-full">
                      <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                    </Button>
                  </a>
                </div>
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => setDialogOpen(false)}
                >
                  Done
                </Button>
              </div>
            ) : (
              /* ── Form state ── */
              <fetcher.Form method="post" className="space-y-4">
                {result?.error && (
                  <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    {result.error}
                  </div>
                )}

                <Input
                  ref={nameRef}
                  label="Shop name"
                  name="name"
                  required
                  onChange={handleNameChange}
                />

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-1.5">
                    Slug
                    <span className="ml-1.5 text-xs text-white/40">(auto-generated, editable)</span>
                  </label>
                  <input
                    name="slug"
                    value={slug}
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setSlugManuallyEdited(true);
                    }}
                    placeholder="my-shop"
                    className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold"
                  />
                  <p className="mt-1 text-xs text-white/30">
                    Final URL: pivotparlor.com/
                    <span className="text-white/50">{slug || "my-shop"}</span>-001
                  </p>
                </div>

                <Input
                  label="Owner email"
                  name="owner_email"
                  type="email"
                  required
                />

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-1.5">
                    Shop type
                  </label>
                  <select
                    name="type"
                    className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
                  >
                    <option value="beauty_parlor" className="bg-[#0D0D0D]">Beauty parlour</option>
                    <option value="barber_shop" className="bg-[#0D0D0D]">Barber shop</option>
                    <option value="both" className="bg-[#0D0D0D]">Both</option>
                  </select>
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "Creating…" : "Create shop & generate invite →"}
                </Button>
              </fetcher.Form>
            )}
          </DialogContent>
        </Dialog>
      </div>

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
            className="text-[#C9A84C] hover:underline"
          >
            View Site →
          </a>
        </div>
      )}

      {devGenJob && (
        <div className="mb-4 rounded-lg border border-[#C9A84C]/30 bg-[#C9A84C]/10 px-4 py-3 text-sm text-[#C9A84C]">
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
                  className="px-4 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {shops.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-white/40">
                  No shops yet. Create your first shop above.
                </td>
              </tr>
            ) : filteredShops.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-white/40">
                  No shops match your search.
                </td>
              </tr>
            ) : (
              filteredShops.map((shop) => {
                const showRegenerate = shop.status === "active" && Boolean(shop.has_site);
                const rowRegenerating = regenerateBusyId === shop.id;
                return (
                  <tr key={shop.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 text-white/50">{shop.shop_number}</td>
                    <td className="px-4 py-3">
                      <span className="font-medium text-white">{shop.name}</span>
                      <span className="ml-2 text-xs text-white/30">/{shop.slug}</span>
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
                        <span className="text-white/30">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{statusBadge(shop)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap gap-2">
                          {shop.stripe_payment_status === "unpaid" && shop.stripe_checkout_url && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => copyPaymentUrl(shop.stripe_checkout_url!)}
                            >
                              <Copy className="h-3.5 w-3.5 mr-1" /> Copy Payment Link
                            </Button>
                          )}
                          {showRegenerate && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={rowRegenerating}
                              onClick={() => void handleRegenerateSite(shop.id)}
                            >
                              {rowRegenerating ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                  Regenerate
                                </>
                              ) : (
                                "Regenerate"
                              )}
                            </Button>
                          )}
                          {shop.has_site ? (
                            <a
                              href={`https://pivotparlor.com/${shop.slug}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Button variant="ghost" size="sm">
                                <ExternalLink className="h-3.5 w-3.5 mr-1" /> View Site
                              </Button>
                            </a>
                          ) : (
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
                          <Link to={`/dev/shops/${shop.id}`}>
                            <Button variant="ghost" size="sm">
                              Details
                            </Button>
                          </Link>
                          <Link to={`/dev/ai-deploy?shopId=${shop.id}`}>
                            <Button variant="ghost" size="sm">
                              <Bot className="h-3.5 w-3.5 mr-1" /> AI Deploy
                            </Button>
                          </Link>
                        </div>
                        {regenerateErrors[shop.id] ? (
                          <p className="text-xs text-red-300 max-w-[14rem] leading-snug">
                            {regenerateErrors[shop.id]}
                          </p>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
