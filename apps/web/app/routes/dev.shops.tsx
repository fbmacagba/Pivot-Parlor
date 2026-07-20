import { useFetcher, useLoaderData, Link, useNavigate, useRevalidator, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Bot, Check, Copy, ExternalLink, Loader2, Sparkles, Trash2 } from "lucide-react";
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
} from "~/components/ui/Dialog";
import type { DevGenerationPrefs } from "./dev.shops.$shopId";
import type { Shop, GenerateSiteActionResult, OnboardResult, DevShopsActionJson } from "~/components/dev-shops/types";
import { COLOR_PALETTES } from "~/lib/color-palettes";
import {
  DEFAULT_TEXT_MODEL,
  DEFAULT_IMAGE_MODEL,
  staticPickerModels,
  REGEN_STEP_LABELS,
  E2E_STRIPE_LIST_SHOPS,
} from "~/components/dev-shops/constants";
import { ModelPicker } from "~/components/dev-shops/ModelPicker";
import {
  regenJobStepStates,
  isTerminalJobState,
  buildRegeneratePayload,
  toSlug,
  resolvePublicAssetImageUrl,
  withImageCacheBust,
} from "~/components/dev-shops/helpers";
import { RegenStepRow } from "~/components/dev-shops/RegenStepRow";
import { StatusBadge } from "~/components/dev-shops/StatusBadge";
import { DeleteShopDialog, type DeleteShopResult } from "~/components/dev-shops/DeleteShopDialog";
import { RatesDialog, type RatesActionResult } from "~/components/dev-shops/RatesDialog";
import { OnboardShopDialog } from "~/components/dev-shops/OnboardShopDialog";

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
  const deleteShopFetcher = useFetcher<DeleteShopResult>();
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
  const [ratesShop, setRatesShop] = useState<Shop | null>(null);
  const ratesFetcher = useFetcher<RatesActionResult>();
  const [regenDesignNotes, setRegenDesignNotes] = useState("");
  const [regenTextModel, setRegenTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [regenTextEffort, setRegenTextEffort] = useState("");
  const [regenImageModel, setRegenImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [regenComposer, setRegenComposer] = useState("ai");

  const [shopToDelete, setShopToDelete] = useState<Shop | null>(null);
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
  /** Colour palette chosen for the next site generation (click-only).
   *  null = no override → the AI picks the palette (the default). */
  const [expPaletteId, setExpPaletteId] = useState<string | null>(null);
  const selectedPalette = expPaletteId
    ? COLOR_PALETTES.find((p) => p.id === expPaletteId) ?? null
    : null;
  /** Regenerate with fresh hero/logo/service photos (skip_images = false).
   *  Defaults on so "Generate Website" produces a complete site; unchecking
   *  keeps the faster path that reuses the existing images. */
  const [regenIncludeImages, setRegenIncludeImages] = useState(true);

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
    if (regenShopId && !shops.some((s) => s.id === regenShopId)) {
      setRegenShopId(null);
    }
  }, [regenShopId, shops]);

  useEffect(() => {
    if (expandedGenJob && !shops.some((s) => s.id === expandedGenJob.shopId)) {
      setExpandedGenJob(null);
      setExpandedGenPoll(null);
    }
  }, [expandedGenJob, shops]);

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
    setRegenTextEffort("");
    setRegenImageModel(DEFAULT_IMAGE_MODEL);
    setRegenComposer("ai");
    regenPrefsFetcher.load(`/api/shops/${regenShopId}/generation-prefs`);
  }, [regenShopId]); // eslint-disable-line react-hooks/exhaustive-deps -- regenPrefsFetcher.load is stable; only shop id matters

  const generateShopImageWithAi = useCallback(
    async (shopId: string, type: "logo" | "hero") => {
      setGenImageError(null);
      setGenImageLoading(type);
      try {
        /**
         * Long OpenRouter image runs can exceed Cloudflare Pages (Remix BFF) wall-clock limits when
         * proxied through /api/... On production *.pivotparlor.com, pp_session is scoped to
         * Domain=.pivotparlor.com so the browser can call the Worker directly with credentials.
         */
        const base = (apiUrl ?? "").trim().replace(/\/$/, "");
        const onPivotParlorHost =
          typeof window !== "undefined" &&
          /^(?:[a-z0-9-]+\.)*pivotparlor\.com$/i.test(window.location.hostname);
        const path = `api/shops/${encodeURIComponent(shopId)}/generate-image`;
        const url =
          onPivotParlorHost && base ? `${base}/${path}` : `/${path}`;
        const res = await fetch(url, {
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
      setExpPaletteId(null);
      setExpandedGenJob(null);
      setExpandedGenPoll(null);
      setGenImageLoading(null);
      setGenImageError(null);
      return;
    }
    const sh = shops.find((s) => s.id === expandedShopId);
    if (!sh) {
      setExpandedShopId(null);
      return;
    }
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
    setExpPaletteId(null);
    setRegenIncludeImages(true);
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
    if (!sh) {
      setExpandedGenJob(null);
      setExpandedGenPoll(null);
      return;
    }
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
    if (deletedId) {
      if (expandedShopId === deletedId) setExpandedShopId(null);
      if (regenShopId === deletedId) setRegenShopId(null);
      if (expandedGenJob?.shopId === deletedId) {
        setExpandedGenJob(null);
        setExpandedGenPoll(null);
      }
      if (devGenJob?.shopId === deletedId) setDevGenJob(null);
    }

    setShopToDelete(null);
    queueMicrotask(() => revalidator.revalidate());
  }, [
    deleteShopFetcher.state,
    deleteShopFetcher.data,
    revalidator,
    shopToDelete,
    expandedShopId,
    regenShopId,
    expandedGenJob?.shopId,
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
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${devGenJob.id}/status`, { cache: "no-store" });
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
    let iv: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (iv !== undefined) {
        clearInterval(iv);
        iv = undefined;
      }
    };
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/status`, { cache: "no-store" });
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
        // Terminal state: keep the final poll (so the panel shows Complete /
        // Failed) but stop polling — leaving the interval running hammered the
        // status endpoint indefinitely. Refresh the list on success so the
        // regenerated site's new state loads.
        if (isTerminalJobState(st ?? "", sg ?? "")) {
          stop();
          if (st !== "failed") revalidator.revalidate();
        }
      } catch {
        /* keep last poll */
      }
    };
    void tick();
    iv = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      stop();
    };
    // Keyed on the job id only: revalidator.revalidate is stable, and including
    // the (identity-unstable) revalidator object would rebuild this interval on
    // every unrelated revalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                const isExpanded = expandedShopId === shop.id;
                const showDraftTools = isActiveShop && shop.has_site && ws === "draft";
                const pollStatus = (expandedGenPoll?.status ?? "").toLowerCase();
                const pollStage = (expandedGenPoll?.stage ?? "").toLowerCase();
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
                          <span className="text-white/50">—</span>
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
                                onClick={() => setRegenShopId(shop.id)}
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
                              <Link to={`/dev/shops/${shop.id}`}>Details</Link>
                            </Button>
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
                    {isExpanded && isActiveShop ? (
                      <tr className="bg-white/[0.03]">
                        <td colSpan={7} className="px-4 py-6">
                          <div className="mx-auto max-w-6xl space-y-6">
                            <div className="grid gap-4 md:grid-cols-3">
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
                                      <Loader2 className="h-8 w-8 animate-spin text-gold" />
                                      <span className="text-xs text-white/55">Generating logo…</span>
                                    </>
                                  ) : expLogoPreview ? (
                                    <img
                                      src={withImageCacheBust(expLogoPreview, expLogoImgBust)}
                                      alt="Logo preview"
                                      className="max-h-36 max-w-full object-contain"
                                    />
                                  ) : (
                                    <span className="text-sm text-white/50">No logo yet</span>
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
                                      <Loader2 className="h-8 w-8 animate-spin text-gold" />
                                      <span className="text-xs text-white/55">Generating hero…</span>
                                    </>
                                  ) : expHeroPreview ? (
                                    <img
                                      src={withImageCacheBust(expHeroPreview, expHeroImgBust)}
                                      alt="Hero preview"
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <span className="text-sm text-white/50">No hero yet</span>
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
                              {/* Colour palette card */}
                              <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
                                <div className="mb-2 flex items-center justify-between">
                                  <h3 className="text-sm font-semibold text-white">Colour palette</h3>
                                  <span className="text-xs text-white/60">{selectedPalette ? selectedPalette.name : "Auto (AI picks)"}</span>
                                </div>
                                <p className="mb-3 text-xs text-white/60">
                                  Applied to the site when you generate the website.
                                </p>
                                <div
                                  className="grid grid-cols-4 gap-2"
                                  role="radiogroup"
                                  aria-label="Colour palette"
                                >
                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={selectedPalette === null}
                                    onClick={() => setExpPaletteId(null)}
                                    className={`col-span-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                                      selectedPalette === null
                                        ? "border-gold text-white ring-2 ring-gold/40"
                                        : "border-white/15 text-white/70 hover:border-white/35"
                                    }`}
                                  >
                                    <Sparkles className="h-4 w-4 shrink-0 text-gold" />
                                    <span className="flex-1">Let AI choose the palette</span>
                                    {selectedPalette === null ? (
                                      <Check className="h-4 w-4 shrink-0 text-gold" />
                                    ) : null}
                                  </button>
                                  {COLOR_PALETTES.map((p) => {
                                    const isSel = p.id === expPaletteId;
                                    return (
                                      <button
                                        key={p.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={isSel}
                                        aria-label={p.name}
                                        title={p.name}
                                        onClick={() => setExpPaletteId(p.id)}
                                        className={`relative flex aspect-square flex-col overflow-hidden rounded-lg border transition-colors ${
                                          isSel
                                            ? "border-gold ring-2 ring-gold/40"
                                            : "border-white/15 hover:border-white/35"
                                        }`}
                                      >
                                        <span className="flex-1" style={{ background: p.primary }} />
                                        <span className="h-2.5 w-full" style={{ background: p.accent }} />
                                        {isSel ? (
                                          <span className="absolute right-1 top-1 rounded-full bg-gold p-0.5 text-black">
                                            <Check className="h-3 w-3" />
                                          </span>
                                        ) : null}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>

                            {genImageError ? (
                              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                                {genImageError}
                              </div>
                            ) : null}

                            <div className="space-y-3">
                              <label className="flex w-fit cursor-pointer select-none items-start gap-2.5 text-sm text-white/80">
                                <input
                                  type="checkbox"
                                  checked={regenIncludeImages}
                                  onChange={(e) => setRegenIncludeImages(e.target.checked)}
                                  className="mt-0.5 h-4 w-4 accent-gold"
                                />
                                <span>
                                  Generate new images (hero, logo, service photos)
                                  <span className="ml-1 text-white/45">
                                    — slower, 1–3 min. Uncheck to reuse the current images.
                                  </span>
                                </span>
                              </label>
                              <div className="flex flex-wrap items-center gap-3">
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={
                                    (!regenIncludeImages && (!expLogoInSync || !expHeroInSync)) ||
                                    expandedGenFetcher.state === "submitting" ||
                                    (expandedGenJob?.shopId === shop.id && !jobComplete && !jobFailed)
                                  }
                                  onClick={() => {
                                    expandedGenFetcher.submit(
                                      buildRegeneratePayload({
                                        includeImages: regenIncludeImages,
                                        palette: selectedPalette,
                                      }),
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
                            </div>

                            {isExpanded &&
                            showExpandedGenProgressUi &&
                            (expandedGenJob?.shopId === shop.id ||
                              (expandedGenFetcher.state === "submitting" && expandedShopId === shop.id)) ? (
                              <div className="rounded-xl border border-gold/30 bg-gold/10 p-4">
                                <h4 className="font-medium text-white">
                                  Generating site for {expandedGenJob?.shopName ?? shop.name}
                                </h4>
                                <p className="mt-1 text-sm text-white/55">
                                  This takes 1–3 minutes. Keep this row open.
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
            <ModelPicker
              label="Text & research"
              models={staticPickerModels("text")}
              value={regenTextModel}
              onChange={setRegenTextModel}
              effort={regenTextEffort}
              onEffortChange={setRegenTextEffort}
              disabled={settingsFetcher.state !== "idle"}
            />
            <ModelPicker
              label="Image"
              models={staticPickerModels("image")}
              value={regenImageModel}
              onChange={setRegenImageModel}
              disabled={settingsFetcher.state !== "idle"}
            />
            <div>
              <label className="mb-1.5 block text-sm font-medium text-white/80">Site composer</label>
              <select
                value={regenComposer}
                onChange={(e) => setRegenComposer(e.target.value)}
                disabled={settingsFetcher.state !== "idle"}
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                <option value="ai" className="bg-dark">AI design director (default)</option>
                <option value="seed" className="bg-dark">Deterministic seed</option>
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
                      text_effort: regenTextEffort,
                      image_model: regenImageModel,
                      composer: regenComposer,
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
