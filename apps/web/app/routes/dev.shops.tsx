import { useFetcher, useLoaderData, Link, useNavigate, useRevalidator, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Bot, Check, Circle, Copy, ExternalLink, Loader2, Plus, Sparkles, XCircle } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { DevGenerationPrefs } from "./dev.shops.$shopId";

const DEFAULT_TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
const DEFAULT_IMAGE_MODEL = "google/gemini-3.1-flash-image-preview";

const TEXT_MODEL_OPTIONS: { value: string; label: string }[] = [
  {
    value: "google/gemini-3.1-flash-lite-preview",
    label:
      "Gemini 3.1 Flash Lite — $0.25/1M in · $1.50/1M out (default)",
  },
  {
    value: "google/gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview — $0.50/1M in · $3.00/1M out",
  },
  {
    value: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview — $2.00/1M in · $12.00/1M out",
  },
  {
    value: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5 — $0.80/1M in · $4.00/1M out",
  },
  {
    value: "anthropic/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 — $3.00/1M in · $15.00/1M out",
  },
  {
    value: "meta-llama/llama-3.3-70b-instruct",
    label: "Llama 3.3 70B — FREE",
  },
];

const IMAGE_MODEL_OPTIONS: { value: string; label: string }[] = [
  {
    value: "google/gemini-3.1-flash-image-preview",
    label:
      "Gemini 3.1 Flash Image (Nano Banana 2) — $0.50/1M in · $3.00/1M out (default)",
  },
  {
    value: "google/gemini-2.5-flash-preview:thinking",
    label:
      "Gemini 2.5 Flash Image (Nano Banana) — $0.50/1M in · $3.00/1M out",
  },
  {
    value: "black-forest-labs/flux-1.1-pro",
    label: "FLUX 1.1 Pro — ~$0.04/image",
  },
  {
    value: "black-forest-labs/flux-schnell",
    label: "FLUX Schnell — FREE",
  },
];

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
  website_status?: string | null;
  hero_image_url?: string | null;
  logo_url?: string | null;
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

const REGEN_STEP_LABELS = [
  "Researching brand & style",
  "Generating website content",
  "Creating hero background image",
  "Creating shop logo",
  "Creating service images",
  "Assembling website",
  "Complete",
] as const;

type RegenStepUiState = "pending" | "active" | "done" | "failed";

/** Map Worker job status/stage to the 7-row progress UI (indices 0–6). */
function regenJobStepStates(status: string, stage: string): RegenStepUiState[] {
  const st = (status || "").toLowerCase();
  const sg = (stage || "").toLowerCase();
  const out: RegenStepUiState[] = Array(7).fill("pending") as RegenStepUiState[];

  if (st === "failed") {
    if (sg === "research") {
      out[0] = "failed";
      return out;
    }
    if (sg === "parallel") {
      out[0] = "done";
      out[1] = "failed";
      return out;
    }
    if (sg === "assemble" || sg === "assembling" || sg === "audit") {
      for (let i = 0; i < 5; i++) out[i] = "done";
      out[5] = "failed";
      return out;
    }
    out[0] = "failed";
    return out;
  }

  if (st === "complete" || sg === "complete" || sg === "done") {
    return Array(7).fill("done") as RegenStepUiState[];
  }

  if (sg === "assemble" || sg === "assembling") {
    for (let i = 0; i < 5; i++) out[i] = "done";
    out[5] = "active";
    return out;
  }

  if (sg === "parallel") {
    out[0] = "done";
    out[1] = "active";
    out[2] = "active";
    out[3] = "active";
    out[4] = "active";
    return out;
  }

  if (sg === "audit" && st === "running") {
    for (let i = 0; i < 5; i++) out[i] = "done";
    out[5] = "active";
    return out;
  }

  if (sg === "research" && (st === "queued" || st === "running" || st === "processing")) {
    out[0] = "active";
    return out;
  }

  out[0] = "active";
  return out;
}

function RegenStepRow({
  label,
  state,
  index,
}: {
  label: string;
  state: RegenStepUiState;
  index: number;
}) {
  const icon =
    state === "done" ? (
      <Check className="h-4 w-4 shrink-0 text-emerald-400" strokeWidth={2.5} aria-hidden />
    ) : state === "active" ? (
      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#C9A84C]" aria-hidden />
    ) : state === "failed" ? (
      <XCircle className="h-4 w-4 shrink-0 text-red-400" aria-hidden />
    ) : (
      <Circle className="h-4 w-4 shrink-0 text-white/25" aria-hidden />
    );

  const labelClass =
    state === "pending"
      ? "text-white/45"
      : state === "active"
        ? "text-white"
        : state === "failed"
          ? "text-red-200"
          : "text-white/90";

  return (
    <li
      className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5 transition-[opacity,transform,border-color] duration-300 ease-out"
      style={{ transitionDelay: `${Math.min(index, 6) * 45}ms` }}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {icon}
      </span>
      <span className={`text-sm leading-snug ${labelClass}`}>{label}</span>
    </li>
  );
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

/** If worker returns a root-relative asset URL, resolve against API origin (Pages origin would 404). */
function resolvePublicAssetImageUrl(raw: string, apiBase: string | undefined): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  const base = (apiBase ?? "").trim().replace(/\/$/, "");
  if (!base) return t;
  if (t.startsWith("/")) return `${base}${t}`;
  return t;
}

/** Append cache-bust query so the browser reloads after upload/save. */
function withImageCacheBust(url: string, bust: number): string {
  if (!url || bust <= 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${bust}`;
}

export default function DevShops() {
  const { shops, apiUrl } = useLoaderData<typeof loader>();
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

  const settingsFetcher = useFetcher<{ ok?: boolean; success?: boolean; error?: string }>();
  const regenPrefsFetcher = useFetcher<{ success?: boolean; data?: DevGenerationPrefs }>();
  const saveImageFetcher = useFetcher<{ ok?: boolean }>();
  const uploadImageFetcher = useFetcher<Record<string, unknown>>();
  const expandedGenFetcher = useFetcher<{ success?: boolean; data?: { jobId?: string } }>();
  const activateActFetcher = useFetcher();
  const pauseActFetcher = useFetcher();
  const wasExpandedGenSubmittingRef = useRef(false);
  const pendingUploadTypeRef = useRef<"logo" | "hero" | null>(null);
  const pendingSaveTypeRef = useRef<"logo" | "hero" | null>(null);
  const pendingSaveUrlRef = useRef<string | null>(null);
  const logoSaveFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroSaveFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [genImageLoading, setGenImageLoading] = useState<"logo" | "hero" | null>(null);
  const [genImageError, setGenImageError] = useState<string | null>(null);

  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [regenShopId, setRegenShopId] = useState<string | null>(null);
  const [regenDesignNotes, setRegenDesignNotes] = useState("");
  const [regenTextModel, setRegenTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [regenImageModel, setRegenImageModel] = useState(DEFAULT_IMAGE_MODEL);

  const [expandedShopId, setExpandedShopId] = useState<string | null>(null);
  const [expLogoPreview, setExpLogoPreview] = useState<string | null>(null);
  const [expHeroPreview, setExpHeroPreview] = useState<string | null>(null);
  const [expLogoPendingUrl, setExpLogoPendingUrl] = useState<string | null>(null);
  const [expHeroPendingUrl, setExpHeroPendingUrl] = useState<string | null>(null);
  /** True when preview matches last server state (no pending save). */
  const [expLogoInSync, setExpLogoInSync] = useState(false);
  const [expHeroInSync, setExpHeroInSync] = useState(false);
  /** Brief "Saved" tick after each successful save. */
  const [expLogoSaveFlash, setExpLogoSaveFlash] = useState(false);
  const [expHeroSaveFlash, setExpHeroSaveFlash] = useState(false);
  const [expLogoImgBust, setExpLogoImgBust] = useState(0);
  const [expHeroImgBust, setExpHeroImgBust] = useState(0);

  const [expandedGenJob, setExpandedGenJob] = useState<{
    jobId: string;
    shopId: string;
    shopSlug: string;
    shopName: string;
  } | null>(null);
  const [expandedGenPoll, setExpandedGenPoll] = useState<{
    status: string;
    stage: string;
    shopSlug?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (settingsFetcher.state !== "idle" || !regenShopId) return;
    const d = settingsFetcher.data;
    if (d?.ok === true) {
      setExpandedShopId(regenShopId);
      setRegenShopId(null);
    }
  }, [settingsFetcher.state, settingsFetcher.data, regenShopId]);

  useEffect(() => {
    if (!regenShopId) return;
    setRegenDesignNotes("");
    setRegenTextModel(DEFAULT_TEXT_MODEL);
    setRegenImageModel(DEFAULT_IMAGE_MODEL);
    regenPrefsFetcher.load(`/api/shops/${regenShopId}/generation-prefs`);
  }, [regenShopId]);

  const generateShopImageWithAi = useCallback(
    async (shopId: string, type: "logo" | "hero") => {
      setGenImageError(null);
      setGenImageLoading(type);
      try {
        const res = await fetch(`/api/shops/${shopId}/generate-image?_data=routes%2Fapi.shops.%24shopId.generate-image`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            image_model:
              typeof regenImageModel === "string" && regenImageModel.trim()
                ? regenImageModel.trim()
                : DEFAULT_IMAGE_MODEL,
            design_notes: regenDesignNotes ?? "",
          }),
        });
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          setGenImageError(`Invalid response (${res.status})`);
          return;
        }
        const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};

        if (!res.ok) {
          const err =
            typeof payload.error === "string" && payload.error.trim()
              ? payload.error.trim()
              : `Request failed (${res.status})`;
          setGenImageError(err);
          return;
        }

        let imageUrl = "";
        const top = payload.imageUrl;
        if (typeof top === "string" && top.trim()) imageUrl = top.trim();
        else {
          const nested = payload.data;
          if (nested && typeof nested === "object" && nested !== null) {
            const inner = (nested as Record<string, unknown>).imageUrl;
            if (typeof inner === "string" && inner.trim()) imageUrl = inner.trim();
          }
        }
        if (!imageUrl) {
          setGenImageError("No image URL returned");
          return;
        }
        console.log("[dev/shops] generate-image 200 raw imageUrl:", imageUrl);
        const absoluteUrl = resolvePublicAssetImageUrl(imageUrl, apiUrl);
        if (absoluteUrl !== imageUrl) {
          console.log("[dev/shops] generate-image resolved against apiUrl:", absoluteUrl);
        }
        if (type === "logo") {
          setExpLogoInSync(false);
          setExpLogoSaveFlash(false);
          setExpLogoPendingUrl(absoluteUrl);
          setExpLogoPreview(absoluteUrl);
          setExpLogoImgBust(Date.now());
        } else {
          setExpHeroInSync(false);
          setExpHeroSaveFlash(false);
          setExpHeroPendingUrl(absoluteUrl);
          setExpHeroPreview(absoluteUrl);
          setExpHeroImgBust(Date.now());
        }
      } catch (e) {
        setGenImageError(e instanceof Error ? e.message : "Network error");
      } finally {
        setGenImageLoading(null);
      }
    },
    [apiUrl, regenDesignNotes, regenImageModel]
  );

  useEffect(() => {
    if (!expandedShopId) {
      if (logoSaveFlashTimerRef.current) {
        clearTimeout(logoSaveFlashTimerRef.current);
        logoSaveFlashTimerRef.current = null;
      }
      if (heroSaveFlashTimerRef.current) {
        clearTimeout(heroSaveFlashTimerRef.current);
        heroSaveFlashTimerRef.current = null;
      }
      setExpLogoPreview(null);
      setExpHeroPreview(null);
      setExpLogoPendingUrl(null);
      setExpHeroPendingUrl(null);
      setExpLogoInSync(false);
      setExpHeroInSync(false);
      setExpLogoSaveFlash(false);
      setExpHeroSaveFlash(false);
      setExpLogoImgBust(0);
      setExpHeroImgBust(0);
      setExpandedGenJob(null);
      setExpandedGenPoll(null);
      setGenImageLoading(null);
      setGenImageError(null);
      return;
    }
    const sh = shops.find((s) => s.id === expandedShopId);
    if (!sh) return;
    setGenImageError(null);
    setGenImageLoading(null);
    const logoResolved = sh.logo_url ? resolvePublicAssetImageUrl(sh.logo_url, apiUrl) : null;
    const heroResolved = sh.hero_image_url ? resolvePublicAssetImageUrl(sh.hero_image_url, apiUrl) : null;
    setExpLogoPreview(logoResolved);
    setExpHeroPreview(heroResolved);
    setExpLogoInSync(Boolean(sh.logo_url));
    setExpHeroInSync(Boolean(sh.hero_image_url));
    setExpLogoSaveFlash(false);
    setExpHeroSaveFlash(false);
    setExpLogoImgBust(Date.now());
    setExpHeroImgBust(Date.now());
    setExpLogoPendingUrl(null);
    setExpHeroPendingUrl(null);
    setExpandedGenJob(null);
    setExpandedGenPoll(null);
  }, [expandedShopId, shops, apiUrl]);

  useEffect(() => {
    if (uploadImageFetcher.state !== "idle") return;
    const t = pendingUploadTypeRef.current;
    pendingUploadTypeRef.current = null;
    if (!t) return;
    const d = uploadImageFetcher.data as { imageUrl?: string } | undefined;
    const url = typeof d?.imageUrl === "string" ? d.imageUrl.trim() : "";
    if (!url) return;
    const absolute = resolvePublicAssetImageUrl(url, apiUrl);
    if (t === "logo") {
      setExpLogoInSync(false);
      setExpLogoSaveFlash(false);
      setExpLogoPendingUrl(absolute);
      setExpLogoPreview(absolute);
      setExpLogoImgBust(Date.now());
    } else {
      setExpHeroInSync(false);
      setExpHeroSaveFlash(false);
      setExpHeroPendingUrl(absolute);
      setExpHeroPreview(absolute);
      setExpHeroImgBust(Date.now());
    }
  }, [uploadImageFetcher.state, uploadImageFetcher.data, apiUrl]);

  useEffect(() => {
    if (saveImageFetcher.state !== "idle") return;
    const t = pendingSaveTypeRef.current;
    const savedUrl = pendingSaveUrlRef.current?.trim() ?? "";
    pendingSaveTypeRef.current = null;
    pendingSaveUrlRef.current = null;
    const d = saveImageFetcher.data as { ok?: boolean } | undefined;
    if (!d?.ok) return;
    revalidator.revalidate();
    if (t === "logo" && savedUrl) {
      const absolute = resolvePublicAssetImageUrl(savedUrl, apiUrl);
      setExpLogoPreview(absolute);
      setExpLogoPendingUrl(null);
      setExpLogoInSync(true);
      setExpLogoImgBust(Date.now());
      setExpLogoSaveFlash(true);
      if (logoSaveFlashTimerRef.current) clearTimeout(logoSaveFlashTimerRef.current);
      logoSaveFlashTimerRef.current = setTimeout(() => {
        setExpLogoSaveFlash(false);
        logoSaveFlashTimerRef.current = null;
      }, 2000);
    }
    if (t === "hero" && savedUrl) {
      const absolute = resolvePublicAssetImageUrl(savedUrl, apiUrl);
      setExpHeroPreview(absolute);
      setExpHeroPendingUrl(null);
      setExpHeroInSync(true);
      setExpHeroImgBust(Date.now());
      setExpHeroSaveFlash(true);
      if (heroSaveFlashTimerRef.current) clearTimeout(heroSaveFlashTimerRef.current);
      heroSaveFlashTimerRef.current = setTimeout(() => {
        setExpHeroSaveFlash(false);
        heroSaveFlashTimerRef.current = null;
      }, 2000);
    }
  }, [saveImageFetcher.state, saveImageFetcher.data, revalidator, apiUrl]);

  useEffect(() => {
    if (expandedGenFetcher.state === "submitting") {
      wasExpandedGenSubmittingRef.current = true;
      return;
    }
    if (expandedGenFetcher.state !== "idle") return;
    if (!wasExpandedGenSubmittingRef.current) return;
    wasExpandedGenSubmittingRef.current = false;
    const raw = expandedGenFetcher.data;
    const jobId = raw?.data?.jobId;
    if (!jobId || !expandedShopId) return;
    const sh = shops.find((s) => s.id === expandedShopId);
    if (!sh) return;
    setExpandedGenJob({
      jobId,
      shopId: sh.id,
      shopSlug: sh.slug,
      shopName: sh.name,
    });
    setExpandedGenPoll(null);
  }, [expandedGenFetcher.state, expandedGenFetcher.data, expandedShopId, shops]);

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

  useEffect(() => {
    if (regenPrefsFetcher.state !== "idle" || !regenShopId) return;
    const raw = regenPrefsFetcher.data;
    if (!raw || typeof raw !== "object") return;
    const envelope = raw as { success?: boolean; data?: DevGenerationPrefs };
    if (envelope.success && envelope.data) {
      setRegenDesignNotes(envelope.data.design_notes ?? "");
    }
  }, [regenPrefsFetcher.state, regenPrefsFetcher.data, regenShopId]);

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

  useEffect(() => {
    if (!expandedGenJob?.jobId) return;
    let cancelled = false;
    const jobId = expandedGenJob.jobId;
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/status`);
        const j = (await r.json()) as {
          success?: boolean;
          data?: { status?: string; stage?: string; shopSlug?: string; error?: string };
        };
        if (cancelled) return;
        if (!j.success || !j.data) return;
        const { status: st, stage: sg, shopSlug, error: err } = j.data;
        setExpandedGenPoll({
          status: st ?? "",
          stage: sg ?? "",
          shopSlug,
          error: err ?? undefined,
        });
      } catch {
        /* keep last poll */
      }
    };
    void tick();
    const iv = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [expandedGenJob?.jobId]);

  const showExpandedGenProgressUi =
    Boolean(expandedGenJob) || expandedGenFetcher.state === "submitting";

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
                const ws = (shop.website_status ?? "draft").toLowerCase();
                const isActiveShop = shop.status === "active";
                const isExpanded = expandedShopId === shop.id;
                const showDraftTools = isActiveShop && shop.has_site && ws === "draft";
                const pollStatus = expandedGenPoll?.status ?? "";
                const pollStage = expandedGenPoll?.stage ?? "";
                const optimisticQueued =
                  expandedGenFetcher.state === "submitting" ||
                  (Boolean(expandedGenJob) && expandedGenJob?.shopId === shop.id && !expandedGenPoll);
                const stepStates = regenJobStepStates(
                  optimisticQueued ? "queued" : pollStatus,
                  optimisticQueued ? "research" : pollStage || "research"
                );
                const jobComplete =
                  pollStatus === "complete" || pollStage === "complete" || pollStage === "done";
                const jobFailed = pollStatus === "failed";

                return (
                  <Fragment key={shop.id}>
                    <tr className="hover:bg-white/[0.02]">
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
                                onClick={() => setRegenShopId(shop.id)}
                              >
                                {ws === "live" || ws === "paused" ? "Edit" : "Regenerate"}
                              </Button>
                            )}
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
                        </div>
                      </td>
                    </tr>
                    {isExpanded && isActiveShop ? (
                      <tr className="bg-white/[0.03]">
                        <td colSpan={7} className="px-4 py-6">
                          <div className="mx-auto max-w-5xl space-y-6">
                            <div className="grid gap-4 md:grid-cols-2">
                              {/* Logo card */}
                              <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
                                <div className="mb-2 flex items-center justify-between">
                                  <h3 className="text-sm font-semibold text-white">Logo</h3>
                                  {expLogoSaveFlash ? (
                                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                                      <Check className="h-3.5 w-3.5" /> Saved
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mb-3 flex aspect-video max-h-40 flex-col items-center justify-center gap-2 rounded-lg bg-white/5">
                                  {genImageLoading === "logo" ? (
                                    <>
                                      <Loader2 className="h-8 w-8 animate-spin text-[#C9A84C]" />
                                      <span className="text-xs text-white/55">Generating logo…</span>
                                    </>
                                  ) : expLogoPreview ? (
                                    <img
                                      src={withImageCacheBust(expLogoPreview, expLogoImgBust)}
                                      alt="Logo preview"
                                      className="max-h-36 max-w-full object-contain"
                                    />
                                  ) : (
                                    <span className="text-sm text-white/35">No logo yet</span>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={genImageLoading !== null}
                                    onClick={() => void generateShopImageWithAi(shop.id, "logo")}
                                  >
                                    Generate with AI
                                  </Button>
                                  <label className="inline-flex cursor-pointer items-center">
                                    <input
                                      type="file"
                                      accept="image/*"
                                      className="sr-only"
                                      disabled={uploadImageFetcher.state === "submitting"}
                                      onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        e.target.value = "";
                                        if (!f) return;
                                        pendingUploadTypeRef.current = "logo";
                                        const fd = new FormData();
                                        fd.set("type", "logo");
                                        fd.set("file", f);
                                        uploadImageFetcher.submit(fd, {
                                          method: "POST",
                                          action: `/api/shops/${shop.id}/upload-image`,
                                          encType: "multipart/form-data",
                                        });
                                      }}
                                    />
                                    <span className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white hover:bg-white/5">
                                      Upload
                                    </span>
                                  </label>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={
                                      saveImageFetcher.state === "submitting" ||
                                      (expLogoInSync && !expLogoPendingUrl) ||
                                      !(expLogoPendingUrl || expLogoPreview)
                                    }
                                    onClick={() => {
                                      const url = expLogoPendingUrl ?? expLogoPreview ?? "";
                                      if (!url) return;
                                      pendingSaveTypeRef.current = "logo";
                                      pendingSaveUrlRef.current = url;
                                      saveImageFetcher.submit(
                                        { type: "logo", imageUrl: url },
                                        {
                                          method: "POST",
                                          action: `/api/shops/${shop.id}/save-image`,
                                          encType: "application/json",
                                        }
                                      );
                                    }}
                                  >
                                    Save Logo
                                  </Button>
                                </div>
                              </div>
                              {/* Hero card */}
                              <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
                                <div className="mb-2 flex items-center justify-between">
                                  <h3 className="text-sm font-semibold text-white">Hero background</h3>
                                  {expHeroSaveFlash ? (
                                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                                      <Check className="h-3.5 w-3.5" /> Saved
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mb-3 flex aspect-video max-h-40 flex-col items-center justify-center gap-2 overflow-hidden rounded-lg bg-white/5">
                                  {genImageLoading === "hero" ? (
                                    <>
                                      <Loader2 className="h-8 w-8 animate-spin text-[#C9A84C]" />
                                      <span className="text-xs text-white/55">Generating hero…</span>
                                    </>
                                  ) : expHeroPreview ? (
                                    <img
                                      src={withImageCacheBust(expHeroPreview, expHeroImgBust)}
                                      alt="Hero preview"
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <span className="text-sm text-white/35">No hero yet</span>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    disabled={genImageLoading !== null}
                                    onClick={() => void generateShopImageWithAi(shop.id, "hero")}
                                  >
                                    Generate with AI
                                  </Button>
                                  <label className="inline-flex cursor-pointer items-center">
                                    <input
                                      type="file"
                                      accept="image/*"
                                      className="sr-only"
                                      disabled={uploadImageFetcher.state === "submitting"}
                                      onChange={(e) => {
                                        const f = e.target.files?.[0];
                                        e.target.value = "";
                                        if (!f) return;
                                        pendingUploadTypeRef.current = "hero";
                                        const fd = new FormData();
                                        fd.set("type", "hero");
                                        fd.set("file", f);
                                        uploadImageFetcher.submit(fd, {
                                          method: "POST",
                                          action: `/api/shops/${shop.id}/upload-image`,
                                          encType: "multipart/form-data",
                                        });
                                      }}
                                    />
                                    <span className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white hover:bg-white/5">
                                      Upload
                                    </span>
                                  </label>
                                  <Button
                                    type="button"
                                    size="sm"
                                    disabled={
                                      saveImageFetcher.state === "submitting" ||
                                      (expHeroInSync && !expHeroPendingUrl) ||
                                      !(expHeroPendingUrl || expHeroPreview)
                                    }
                                    onClick={() => {
                                      const url = expHeroPendingUrl ?? expHeroPreview ?? "";
                                      if (!url) return;
                                      pendingSaveTypeRef.current = "hero";
                                      pendingSaveUrlRef.current = url;
                                      saveImageFetcher.submit(
                                        { type: "hero", imageUrl: url },
                                        {
                                          method: "POST",
                                          action: `/api/shops/${shop.id}/save-image`,
                                          encType: "application/json",
                                        }
                                      );
                                    }}
                                  >
                                    Save Hero
                                  </Button>
                                </div>
                              </div>
                            </div>

                            {genImageError ? (
                              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                                {genImageError}
                              </div>
                            ) : null}

                            <div className="flex flex-wrap items-center gap-3">
                              <Button
                                type="button"
                                size="sm"
                                disabled={
                                  !expLogoInSync ||
                                  !expHeroInSync ||
                                  expandedGenFetcher.state === "submitting" ||
                                  (expandedGenJob?.shopId === shop.id && !jobComplete && !jobFailed)
                                }
                                onClick={() => {
                                  expandedGenFetcher.submit(
                                    { skip_images: true },
                                    {
                                      method: "POST",
                                      action: `/api/shops/${shop.id}/generate-site`,
                                      encType: "application/json",
                                    }
                                  );
                                }}
                              >
                                {expandedGenFetcher.state === "submitting" ? (
                                  <>
                                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Starting…
                                  </>
                                ) : (
                                  "Generate Website →"
                                )}
                              </Button>
                            </div>

                            {isExpanded &&
                            showExpandedGenProgressUi &&
                            (expandedGenJob?.shopId === shop.id ||
                              (expandedGenFetcher.state === "submitting" && expandedShopId === shop.id)) ? (
                              <div className="rounded-xl border border-[#C9A84C]/30 bg-[#C9A84C]/10 p-4">
                                <h4 className="font-medium text-white">
                                  Generating site for {expandedGenJob?.shopName ?? shop.name}
                                </h4>
                                <p className="mt-1 text-sm text-white/55">
                                  This takes 1–2 minutes. Keep this row open.
                                </p>
                                <ol className="mt-3 list-none space-y-2 p-0" aria-label="Generation progress">
                                  {REGEN_STEP_LABELS.map((label, i) => (
                                    <RegenStepRow key={label} label={label} state={stepStates[i]!} index={i} />
                                  ))}
                                </ol>
                                {jobFailed ? (
                                  <div className="mt-4 space-y-2">
                                    <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                                      {expandedGenPoll?.error ?? "Generation failed."}
                                    </div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        setExpandedGenJob(null);
                                        setExpandedGenPoll(null);
                                      }}
                                    >
                                      Try Again
                                    </Button>
                                  </div>
                                ) : null}
                                {jobComplete ? (
                                  <div className="mt-4 flex flex-wrap gap-2">
                                    <Button
                                      type="button"
                                      size="sm"
                                      onClick={() => navigate(`/dev/shops/${shop.id}/preview`)}
                                    >
                                      Preview Site
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        setExpandedShopId(null);
                                        setExpandedGenJob(null);
                                        setExpandedGenPoll(null);
                                      }}
                                    >
                                      Close
                                    </Button>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={regenShopId !== null}
        onOpenChange={(open) => {
          if (!open) setRegenShopId(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {regenShopId ? shops.find((s) => s.id === regenShopId)?.name ?? "Shop settings" : "Shop settings"}
            </DialogTitle>
          </DialogHeader>

          {regenPrefsFetcher.state === "loading" && (
            <p className="text-sm text-white/60">Loading generation preferences…</p>
          )}

          {settingsFetcher.data &&
          settingsFetcher.state === "idle" &&
          (settingsFetcher.data.ok === false ||
            (settingsFetcher.data.success === false && settingsFetcher.data.error)) ? (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {settingsFetcher.data.error?.trim() || "Could not save settings."}
            </div>
          ) : null}

          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-white/80">Design notes</label>
              <textarea
                value={regenDesignNotes}
                onChange={(e) => setRegenDesignNotes(e.target.value)}
                rows={4}
                disabled={settingsFetcher.state !== "idle"}
                className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold"
                placeholder="Style and content hints for the pipeline…"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-white/80">Text &amp; Research Model</label>
              <select
                value={regenTextModel}
                onChange={(e) => setRegenTextModel(e.target.value)}
                disabled={settingsFetcher.state !== "idle"}
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {TEXT_MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} className="bg-[#0D0D0D]">
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-white/80">Image Model</label>
              <select
                value={regenImageModel}
                onChange={(e) => setRegenImageModel(e.target.value)}
                disabled={settingsFetcher.state !== "idle"}
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {IMAGE_MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} className="bg-[#0D0D0D]">
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={settingsFetcher.state !== "idle"}
                onClick={() => setRegenShopId(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="min-w-[10rem]"
                disabled={settingsFetcher.state !== "idle" || !regenShopId || regenPrefsFetcher.state === "loading"}
                onClick={() => {
                  if (!regenShopId) return;
                  settingsFetcher.submit(
                    {
                      design_notes: regenDesignNotes,
                      text_model: regenTextModel,
                      image_model: regenImageModel,
                    },
                    {
                      method: "POST",
                      action: `/api/shops/${regenShopId}/settings`,
                      encType: "application/json",
                    }
                  );
                }}
              >
                {settingsFetcher.state !== "idle" ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save Settings"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
