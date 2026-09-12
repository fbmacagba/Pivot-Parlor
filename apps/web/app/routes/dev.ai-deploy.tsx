import { useLoaderData, useSearchParams } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Badge } from "~/components/ui/Badge";
import { COLOR_PALETTES } from "~/lib/color-palettes";
import { ModelPicker } from "~/components/dev-shops/ModelPicker";
import { ChatbotModelCard } from "~/components/dev-shops/ChatbotModelCard";
import { pickerModelsFrom } from "~/components/dev-shops/constants";
import { DEFAULT_TEXT_MODEL_ID } from "@repo/utils";
import type { AIModel, BrandConfig } from "@repo/types";

interface Shop {
  id: string;
  name: string;
  type: string;
}

type ChatbotModelRecord = { model_id: string | null; updated_at: string | null };

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  let shops: Shop[] = [];
  let models: AIModel[] = [];
  try {
    [shops, models] = await Promise.all([
      api.get<Shop[]>("/api/shops"),
      api.get<AIModel[]>("/api/ai/models"),
    ]);
  } catch {
    // silent
  }
  // Separate try: a failure here must not blank the model list.
  let chatbotModel: ChatbotModelRecord = { model_id: null, updated_at: null };
  try {
    chatbotModel = await api.get<ChatbotModelRecord>("/api/ai/chatbot-model");
  } catch {
    // card shows the code default
  }
  return json({ shops, models, chatbotModel, apiUrl: env.API_URL });
}

type ThemeResult = { theme: BrandConfig; model: string; modelId: string } | null;

export default function DevAIDeploy() {
  const { shops, models, chatbotModel, apiUrl } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

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

  const selectedPalette = paletteId ? COLOR_PALETTES.find((p) => p.id === paletteId) ?? null : null;

  const modelId = modelChoice || recommendedId;
  const selectedModel = textModels.find((m) => m.id === modelId);
  const effortAvailable = selectedModel?.supportsEffort ?? false;

  /**
   * Theme generation can run for a while on high-effort models. On production
   * *.pivotparlor.com, pp_session is scoped to Domain=.pivotparlor.com so the
   * browser calls the Worker directly with credentials (no Pages wall-clock
   * limit); elsewhere (local dev, pages.dev previews) the relative path hits
   * the api.ai.* Remix proxy routes. pp_session is HttpOnly, so cookie
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
        ...(effortAvailable && effort ? { effort } : {}),
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
        ...(effortAvailable && effort ? { effort } : {}),
      })) as { data?: { model_a: CompareSide; model_b: CompareSide }; error?: string };
      if (!data.data) throw new Error(data.error ?? "Comparison failed");
      const { model_a, model_b } = data.data;
      if (!model_a.theme) throw new Error(model_a.error ?? "Model A generation failed");
      if (!model_b.theme) throw new Error(model_b.error ?? "Model B generation failed");
      setResult({ theme: model_a.theme, model: selectedModel?.name ?? modelId, modelId });
      setResultB({
        theme: model_b.theme,
        model: models.find((m) => m.id === modelBId)?.name ?? modelBId,
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
    setError("");
    try {
      await postJson("/api/ai/apply-theme", {
        shop_id: shopId,
        model_id: chosen.modelId,
        theme: chosen.theme,
      });
      setApplied(side);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setApplying(null);
    }
  }

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">AI Deploy</h1>
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Left: Controls */}
        <div className="w-full space-y-5 lg:w-2/5">
          {/* Shop selector */}
          <div>
            <label className="block text-sm font-medium text-white/80 mb-1.5">Shop</label>
            <select
              value={shopId}
              onChange={(e) => setShopId(e.target.value)}
              className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
            >
              <option value="" className="bg-dark">Select shop…</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id} className="bg-dark">{s.name}</option>
              ))}
            </select>
          </div>

          {/* Model selector — top 10 providers via OpenRouter, live pricing */}
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
            <p className="mt-1 text-xs text-white/50">
              {textModels.some((m) => m.livePricing)
                ? "Live pricing, refreshed hourly."
                : "Price feed unreachable, showing last-known pricing."}
            </p>
          </div>

          {/* Colour palette — Let AI choose (default) or lock a curated pair */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="block text-sm font-medium text-white/80">Colour palette</label>
              <span className="text-xs text-white/60">
                {selectedPalette ? selectedPalette.name : "Auto (AI picks)"}
              </span>
            </div>
            <div className="space-y-1.5" role="radiogroup" aria-label="Colour palette">
              <button
                type="button"
                role="radio"
                aria-checked={selectedPalette === null}
                onClick={() => setPaletteId(null)}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selectedPalette === null
                    ? "border-gold bg-gold/10 text-white"
                    : "border-white/10 bg-dark-100 text-white/70 hover:border-white/20"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5 text-gold" />
                <span className="flex-1">Let AI choose the palette</span>
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
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors ${
                        isSel
                          ? "border-gold bg-gold/10 text-white"
                          : "border-white/10 bg-dark-100 text-white/70 hover:border-white/20"
                      }`}
                    >
                      <span className="flex shrink-0 overflow-hidden rounded-full border border-white/20">
                        <span className="h-4 w-4" style={{ background: p.primary }} />
                        <span className="h-4 w-4" style={{ background: p.accent }} />
                      </span>
                      <span className="truncate">{p.name}</span>
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

          <div className="flex gap-2">
            <Button onClick={handleGenerate} disabled={loading || !shopId} className="flex-1">
              <Sparkles className="h-4 w-4" />
              {loading && !compareMode ? "Generating…" : "Generate"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setCompareMode(!compareMode)}
              className={compareMode ? "border-gold text-gold" : ""}
            >
              Compare
            </Button>
          </div>

          {compareMode && (
            <div>
              <ModelPicker
                label="Model B"
                models={textModels}
                value={modelBId}
                onChange={setModelBId}
              />
              <Button onClick={handleCompare} disabled={loading || !shopId || !modelBId} className="mt-2 w-full">
                {loading && compareMode ? "Comparing…" : "Compare models"}
              </Button>
            </div>
          )}

          <ChatbotModelCard
            models={textModels}
            savedModelId={chatbotModel.model_id}
            savedAt={chatbotModel.updated_at}
            defaultModelId={DEFAULT_TEXT_MODEL_ID}
            onSave={async (id) => {
              await postJson("/api/ai/chatbot-model", { model_id: id });
            }}
          />

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Right: Preview */}
        <div className={`flex-1 ${compareMode && result && resultB ? "grid grid-cols-2 gap-4" : ""}`}>
          {result ? (
            <BrandPreview
              theme={result.theme}
              modelLabel={result.model}
              applyState={applied === "A" ? "applied" : applying === "A" ? "applying" : "idle"}
              applyDisabled={applying !== null}
              onApply={() => handleApply("A")}
            />
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-white/20 text-sm text-white/50">
              Generate a theme to see a preview here — nothing changes on the shop site until you apply one
            </div>
          )}
          {compareMode && resultB && (
            <BrandPreview
              theme={resultB.theme}
              modelLabel={resultB.model}
              applyState={applied === "B" ? "applied" : applying === "B" ? "applying" : "idle"}
              applyDisabled={applying !== null}
              onApply={() => handleApply("B")}
            />
          )}
        </div>
      </div>
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
      <p className="text-xs text-white/50">{theme.trustStatement}</p>
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
        {applyState === "applied"
          ? "✓ Applied to shop site"
          : applyState === "applying"
            ? "Applying…"
            : "Use this theme"}
      </Button>
    </div>
  );
}
