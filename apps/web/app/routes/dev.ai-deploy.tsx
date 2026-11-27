import { useLoaderData, useRevalidator, useSearchParams, data as json } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { Badge } from "~/components/ui/Badge";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { pageTitle } from "~/lib/pageTitle";
import { COLOR_PALETTES } from "~/lib/color-palettes";
import { ModelPicker } from "~/components/dev-shops/ModelPicker";
import { ChatbotModelCard } from "~/components/dev-shops/ChatbotModelCard";
import { pickerModelsFrom } from "~/components/dev-shops/constants";
import { effortToSend } from "~/components/dev-shops/modelPicker.helpers";
import { DEFAULT_TEXT_MODEL_ID } from "@repo/utils";
import type { AIModel, BrandConfig } from "@repo/types";

interface Shop {
  id: string;
  name: string;
  slug?: string;
  type: string;
  has_site?: number | null;
  website_status?: string | null;
}

type SiteState = "live" | "paused" | "draft" | "none";

function siteStateOf(shop: Shop): SiteState {
  if (!shop.has_site) return "none";
  const ws = (shop.website_status ?? "draft").toLowerCase();
  return ws === "live" ? "live" : ws === "paused" ? "paused" : "draft";
}

/** The shop picker's groups, live sites first: applying a theme there is public at once. */
const SITE_GROUPS: { state: SiteState; label: string }[] = [
  { state: "live", label: "Site live" },
  { state: "paused", label: "Site paused" },
  { state: "draft", label: "Site in draft" },
  { state: "none", label: "No site yet" },
];

type ChatbotModelRecord = { model_id: string | null; effort?: string | null; updated_at: string | null };

export const meta = () => pageTitle("AI Deploy");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev" homeLabel="Back to overview" />;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  // Three independent reads: one failing must not blank the other two, and
  // each failure is said on the page rather than shown as an empty list.
  const [shopsR, modelsR, chatbotR] = await Promise.allSettled([
    api.get<Shop[]>("/api/shops"),
    api.get<AIModel[]>("/api/ai/models"),
    api.get<ChatbotModelRecord>("/api/ai/chatbot-model"),
  ]);
  const shopsOk = shopsR.status === "fulfilled" && Array.isArray(shopsR.value);
  const modelsOk = modelsR.status === "fulfilled" && Array.isArray(modelsR.value) && modelsR.value.length > 0;
  return json({
    shops: shopsOk ? shopsR.value : [],
    shopsError: !shopsOk,
    models: modelsOk ? modelsR.value : [],
    // True when the live model list could not be read: the pickers then offer
    // the list built into this release, with its last-known prices.
    modelsFallback: !modelsOk,
    chatbotModel:
      chatbotR.status === "fulfilled" && chatbotR.value
        ? chatbotR.value
        : ({ model_id: null, effort: null, updated_at: null } satisfies ChatbotModelRecord),
    // False when the saved chatbot choice could not be read: the card must
    // not claim "using the code default" when a choice may well be saved.
    chatbotLoaded: chatbotR.status === "fulfilled" && Boolean(chatbotR.value),
    apiUrl: env.API_URL,
  });
}

type ThemeResult = { theme: BrandConfig; model: string; modelId: string } | null;

export default function DevAIDeploy() {
  const { shops, shopsError, models, modelsFallback, chatbotModel, chatbotLoaded, apiUrl } =
    useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const revalidator = useRevalidator();

  const textModels = pickerModelsFrom(models, "text");
  const recommendedId = textModels.find((m) => m.recommended)?.id ?? textModels[0]?.id ?? "";

  const [shopId, setShopId] = useState(params.get("shopId") ?? "");
  const [modelChoice, setModelChoice] = useState("");
  const [effort, setEffort] = useState("");
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [modelBId, setModelBId] = useState("");
  const [keywords, setKeywords] = useState("");
  const [compareMode, setCompareMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ThemeResult>(null);
  const [resultB, setResultB] = useState<ThemeResult>(null);
  const [applying, setApplying] = useState<"A" | "B" | null>(null);
  const [applied, setApplied] = useState<"A" | "B" | null>(null);
  const [error, setError] = useState("");
  // Applying writes to the shop's site and has no undo, so it is confirmed first.
  const [confirmApply, setConfirmApply] = useState<"A" | "B" | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const selectedShop = shops.find((s) => s.id === shopId) ?? null;
  const selectedSiteState: SiteState = selectedShop ? siteStateOf(selectedShop) : "none";

  const selectedPalette = paletteId ? COLOR_PALETTES.find((p) => p.id === paletteId) ?? null : null;

  const modelId = modelChoice || recommendedId;
  const selectedModel = textModels.find((m) => m.id === modelId);
  // Only a level the chosen model takes is sent; "" lets the model decide.
  const sentEffort = effortToSend(selectedModel, effort);

  /**
   * Theme generation can run for a while on high-effort models. On production
   * *.pivotparlor.com, pp_session is scoped to Domain=.pivotparlor.com so the
   * browser calls the Worker directly with credentials (no Pages wall-clock
   * limit); elsewhere (local dev, pages.dev previews) the relative path hits
   * the api.ai.* proxy routes. pp_session is HttpOnly, so cookie
   * credentials are the ONLY way to authenticate from the browser.
   */
  function workerUrl(path: string): string {
    const base = (apiUrl ?? "").trim().replace(/\/$/, "");
    const onPivotParlorHost =
      typeof window !== "undefined" &&
      /^(?:[a-z0-9-]+\.)*pivotparlor\.com$/i.test(window.location.hostname);
    return onPivotParlorHost && base ? `${base}${path}` : path;
  }

  async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(workerUrl(path), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Unexpected non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const err = (data as { error?: string })?.error;
      throw new Error(err?.trim() || `Request failed (HTTP ${res.status})`);
    }
    return data;
  }

  function paletteBody(): Record<string, string> {
    return selectedPalette
      ? { color_primary: selectedPalette.primary, color_accent: selectedPalette.accent }
      : {};
  }

  async function handleGenerate() {
    if (!shopId || !modelId) return;
    setLoading(true);
    setError("");
    setApplied(null);
    try {
      const data = (await postJson("/api/ai/generate-theme", {
        shop_id: shopId,
        model_id: modelId,
        style_keywords: keywords,
        regenerate: true,
        preview: true,
        ...paletteBody(),
        ...(sentEffort ? { effort: sentEffort } : {}),
      })) as { data?: BrandConfig; error?: string };
      if (!data.data) throw new Error(data.error ?? "Generation failed");
      setResult({ theme: data.data, model: selectedModel?.name ?? modelId, modelId });
      setResultB(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleCompare() {
    if (!shopId || !modelId || !modelBId) return;
    setLoading(true);
    setError("");
    setApplied(null);
    try {
      type CompareSide = { id: string; theme: BrandConfig | null; error: string | null };
      const data = (await postJson("/api/ai/compare", {
        shop_id: shopId,
        model_a_id: modelId,
        model_b_id: modelBId,
        style_keywords: keywords,
        ...paletteBody(),
        ...(sentEffort ? { effort: sentEffort } : {}),
      })) as { data?: { model_a: CompareSide; model_b: CompareSide }; error?: string };
      if (!data.data) throw new Error(data.error ?? "Comparison failed");
      const { model_a, model_b } = data.data;
      if (!model_a.theme) throw new Error(model_a.error ?? "Model A generation failed");
      if (!model_b.theme) throw new Error(model_b.error ?? "Model B generation failed");
      setResult({ theme: model_a.theme, model: selectedModel?.name ?? modelId, modelId });
      setResultB({
        theme: model_b.theme,
        model: textModels.find((m) => m.id === modelBId)?.name ?? modelBId,
        modelId: modelBId,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleApply(side: "A" | "B") {
    const chosen = side === "A" ? result : resultB;
    if (!chosen || !shopId || applying) return;
    setApplying(side);
    setApplyError(null);
    try {
      await postJson("/api/ai/apply-theme", {
        shop_id: shopId,
        model_id: chosen.modelId,
        theme: chosen.theme,
      });
      setApplied(side);
      setConfirmApply(null);
    } catch (e: unknown) {
      // Shown inside the confirmation, which stays open, so it is not missed.
      setApplyError(
        `The theme was not applied. The shop's site is unchanged. (${e instanceof Error ? e.message : "Unknown error"})`,
      );
    } finally {
      setApplying(null);
    }
  }

  const confirmTheme = confirmApply === "A" ? result : confirmApply === "B" ? resultB : null;

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">AI Deploy</h1>
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left: Controls */}
        <div className="w-full space-y-5 lg:w-2/5">
          {/* Shop selector, grouped by what applying a theme would touch */}
          {shopsError ? (
            <LoadError what="the shops list" />
          ) : (
            <div>
              <Select
                label="Shop"
                value={shopId}
                onChange={(e) => {
                  setShopId(e.target.value);
                  // A theme is generated for one shop: never leave another
                  // shop's result on screen with an Apply button under it.
                  setResult(null);
                  setResultB(null);
                  setApplied(null);
                  setError("");
                }}
              >
                <option value="">Select a shop…</option>
                {SITE_GROUPS.map((group) => {
                  const inGroup = shops.filter((s) => siteStateOf(s) === group.state);
                  return inGroup.length === 0 ? null : (
                    <optgroup key={group.state} label={group.label}>
                      {inGroup.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </Select>
              {shops.length === 0 && (
                <p className="mt-1 text-xs text-white/60">There are no shops yet. Onboard one from the Shops page.</p>
              )}
            </div>
          )}

          {/* Model selector: live-priced list, or the built-in one */}
          <div>
            <ModelPicker
              label="Theme"
              models={textModels}
              value={modelId}
              onChange={(id) => {
                setModelChoice(id);
                setEffort("");
              }}
              effort={effort}
              onEffortChange={setEffort}
            />
            {modelsFallback ? (
              <p role="status" className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                The live model list could not be loaded, so these are the models built into this release with their
                last-known prices. A model listed here may no longer be offered; reload to try the live list again.
              </p>
            ) : (
              <p className="mt-1 text-xs text-white/60">
                {textModels.some((m) => m.livePricing)
                  ? "Live pricing, refreshed hourly."
                  : "Price feed unreachable, showing last-known pricing."}
              </p>
            )}
          </div>

          {/* Colour palette: let AI choose (default) or lock a curated pair */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p id="ai-deploy-palette-label" className="text-sm font-medium text-white/80">
                Colour palette
              </p>
              <span className="text-xs text-white/60">
                {selectedPalette ? selectedPalette.name : "Auto (AI picks)"}
              </span>
            </div>
            <div className="space-y-1.5" role="radiogroup" aria-labelledby="ai-deploy-palette-label">
              <button
                type="button"
                role="radio"
                aria-checked={selectedPalette === null}
                onClick={() => setPaletteId(null)}
                className={`tap-target flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                  selectedPalette === null
                    ? "border-gold bg-gold/10 font-medium text-white"
                    : "border-white/10 bg-dark-100 text-white/70 hover:border-white/20"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5 text-gold" aria-hidden />
                <span className="flex-1">Let AI choose the palette</span>
                {selectedPalette === null ? <Check className="h-4 w-4 shrink-0 text-gold" aria-hidden /> : null}
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                {COLOR_PALETTES.map((p) => {
                  const isSel = p.id === paletteId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={isSel}
                      onClick={() => setPaletteId(isSel ? null : p.id)}
                      className={`tap-target flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                        isSel
                          ? "border-gold bg-gold/10 font-medium text-white"
                          : "border-white/10 bg-dark-100 text-white/70 hover:border-white/20"
                      }`}
                    >
                      <span className="flex shrink-0 overflow-hidden rounded-full border border-white/20" aria-hidden>
                        <span className="h-4 w-4" style={{ background: p.primary }} />
                        <span className="h-4 w-4" style={{ background: p.accent }} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {isSel ? <Check className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <Input
            label="Style keywords (optional)"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="e.g. luxury, minimalist, bold, feminine"
          />

          <div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={compareMode ? "secondary" : "default"}
                onClick={handleGenerate}
                disabled={loading || !shopId}
                className="flex-1"
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                {loading && !compareMode ? "Generating…" : "Generate"}
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-pressed={compareMode}
                onClick={() => setCompareMode(!compareMode)}
                className={compareMode ? "bg-gold/10 font-semibold" : ""}
              >
                {compareMode ? <Check className="h-4 w-4" aria-hidden /> : null}
                Compare
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-white/60">
              Generate makes one paid AI call. Compare makes two, one for each model. Nothing changes on the shop
              site until you apply a theme.
            </p>
          </div>

          {compareMode && (
            <div>
              <ModelPicker
                label="Model B"
                models={textModels}
                value={modelBId}
                onChange={setModelBId}
              />
              <Button
                type="button"
                onClick={handleCompare}
                disabled={loading || !shopId || !modelBId}
                className="mt-2 w-full"
              >
                {loading && compareMode ? "Comparing…" : "Compare models (two paid calls)"}
              </Button>
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          {chatbotLoaded ? (
            <ChatbotModelCard
              models={textModels}
              savedModelId={chatbotModel.model_id}
              savedEffort={chatbotModel.effort ?? null}
              savedAt={chatbotModel.updated_at}
              defaultModelId={DEFAULT_TEXT_MODEL_ID}
              onSave={async (id, effort) => {
                await postJson("/api/ai/chatbot-model", { model_id: id, ...(effort ? { effort } : {}) });
                revalidator.revalidate();
              }}
            />
          ) : (
            // The saved choice could not be read: offering the card would show
            // "code default" and invite saving over a choice that may exist.
            <section className="space-y-3 rounded-xl border border-white/10 bg-dark-100 p-4">
              <h2 className="font-heading text-lg font-bold text-white">Shop chatbot model</h2>
              <LoadError what="the saved chatbot model" />
            </section>
          )}
        </div>

        {/* Right: Preview */}
        <div className={`flex-1 ${compareMode && result && resultB ? "grid grid-cols-1 gap-4 lg:grid-cols-2" : ""}`}>
          {result ? (
            <BrandPreview
              theme={result.theme}
              modelLabel={result.model}
              applyState={applied === "A" ? "applied" : applying === "A" ? "applying" : "idle"}
              applyDisabled={applying !== null}
              onApply={() => {
                setApplyError(null);
                setConfirmApply("A");
              }}
            />
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-white/20 px-4 text-center text-sm text-white/60">
              Generate a theme to see a preview here. Nothing changes on the shop site until you apply one.
            </div>
          )}
          {compareMode && resultB && (
            <BrandPreview
              theme={resultB.theme}
              modelLabel={resultB.model}
              applyState={applied === "B" ? "applied" : applying === "B" ? "applying" : "idle"}
              applyDisabled={applying !== null}
              onApply={() => {
                setApplyError(null);
                setConfirmApply("B");
              }}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmApply !== null}
        onCancel={() => {
          setConfirmApply(null);
          setApplyError(null);
        }}
        onConfirm={() => {
          if (confirmApply) void handleApply(confirmApply);
        }}
        title={`Apply this theme to ${selectedShop?.name ?? "the shop"}?`}
        confirmLabel="Apply theme"
        pendingLabel="Applying…"
        pending={applying !== null}
        error={applyError}
      >
        <p>
          This replaces the theme saved for <span className="font-medium text-white">{selectedShop?.name}</span>{" "}
          (colours, fonts and headline copy) with the {confirmTheme?.model ?? "generated"} version shown.
        </p>
        <p className="font-medium text-white">
          {selectedSiteState === "live"
            ? "This shop's site is live, so customers see the change straight away."
            : selectedSiteState === "paused"
              ? "This shop's site is paused. The change shows when the site is resumed."
              : selectedSiteState === "draft"
                ? "This shop's site is a draft, so nothing public changes yet."
                : "This shop has no generated site yet, so nothing public changes."}
        </p>
        <p>There is no undo. To go back you would have to generate and apply another theme.</p>
      </ConfirmDialog>
    </div>
  );
}

function BrandPreview({
  theme,
  modelLabel,
  applyState,
  applyDisabled,
  onApply,
}: {
  theme: BrandConfig;
  modelLabel: string;
  applyState: "idle" | "applying" | "applied";
  applyDisabled: boolean;
  onApply: () => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-white/60 uppercase tracking-wider">Preview</p>
        <Badge variant="outline">{modelLabel}</Badge>
      </div>
      <div className="flex gap-3">
        <div className="flex flex-col items-center gap-1">
          <div className="h-10 w-10 rounded-full border border-white/10" style={{ background: theme.primaryColor }} />
          <p className="text-xs text-white/60">Primary</p>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="h-10 w-10 rounded-full border border-white/10" style={{ background: theme.accentColor }} />
          <p className="text-xs text-white/60">Accent</p>
        </div>
      </div>
      <p className="font-heading text-lg font-bold text-white" style={{ fontFamily: `"${theme.fontHeading}", serif` }}>
        {theme.heroHeadline}
      </p>
      <p className="text-sm text-white/70 italic">&ldquo;{theme.tagline}&rdquo;</p>
      <p className="text-sm text-white/60">{theme.heroSubheadline}</p>
      <div className="rounded-lg px-4 py-2 text-sm font-semibold text-center" style={{ background: theme.accentColor, color: theme.primaryColor }}>
        {theme.ctaText}
      </div>
      <p className="text-xs text-amber-400">{theme.urgencyText}</p>
      <p className="text-xs text-white/60">{theme.trustStatement}</p>
      <div className="flex flex-wrap gap-1">
        {theme.aestheticKeywords.map((kw) => (
          <Badge key={kw} variant="outline">{kw}</Badge>
        ))}
      </div>
      <Button
        onClick={onApply}
        disabled={applyDisabled || applyState === "applied"}
        className="w-full"
        variant={applyState === "applied" ? "outline" : "default"}
      >
        {applyState === "applied" ? (
          <>
            <Check className="h-4 w-4" aria-hidden /> Applied to shop site
          </>
        ) : applyState === "applying" ? (
          "Applying…"
        ) : (
          "Use this theme…"
        )}
      </Button>
    </div>
  );
}
