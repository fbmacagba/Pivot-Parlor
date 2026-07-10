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
import type { AIModel, BrandConfig } from "@repo/types";

interface Shop {
  id: string;
  name: string;
  type: string;
}

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
  return json({ shops, models });
}

type ThemeResult = { theme: BrandConfig; model: string } | null;

export default function DevAIDeploy() {
  const { shops, models } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  const recommendedId = models.find((m) => m.recommended)?.id ?? models[0]?.id ?? "";

  const [shopId, setShopId] = useState(params.get("shopId") ?? "");
  const [modelChoice, setModelChoice] = useState("");
  const [effort, setEffort] = useState("");
  const [modelBId, setModelBId] = useState("");
  const [keywords, setKeywords] = useState("");
  const [compareMode, setCompareMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ThemeResult>(null);
  const [resultB, setResultB] = useState<ThemeResult>(null);
  const [error, setError] = useState("");

  const modelId = modelChoice || recommendedId;
  const selectedModel = models.find((m) => m.id === modelId);
  const effortAvailable = selectedModel?.supportsEffort ?? false;

  const token = typeof document !== "undefined"
    ? document.cookie.split(";").find((c) => c.trim().startsWith("pp_session="))?.split("=")[1]
    : null;

  function modelOptionLabel(m: AIModel): string {
    const price = `$${m.costPer1MInput}/M in · $${m.costPer1MOutput}/M out`;
    const flags = [m.recommended ? "★ recommended" : "", m.supportsEffort ? "effort" : ""]
      .filter(Boolean)
      .join(", ");
    return `${m.providerLabel} | ${m.name} — ${price}${flags ? ` (${flags})` : ""}`;
  }

  async function handleGenerate() {
    if (!shopId || !modelId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api-proxy/api/ai/generate-theme", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          shop_id: shopId,
          model_id: modelId,
          style_keywords: keywords,
          ...(effortAvailable && effort ? { effort } : {}),
        }),
      });
      const data = (await res.json()) as { data?: BrandConfig; error?: string };
      if (!res.ok || !data.data) throw new Error(data.error ?? "Generation failed");
      setResult({ theme: data.data, model: selectedModel?.name ?? modelId });
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
    try {
      const res = await fetch("/api-proxy/api/ai/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          shop_id: shopId,
          model_a_id: modelId,
          model_b_id: modelBId,
          style_keywords: keywords,
          ...(effortAvailable && effort ? { effort } : {}),
        }),
      });
      const data = (await res.json()) as { data?: { modelA: { result: BrandConfig }; modelB: { result: BrandConfig } }; error?: string };
      if (!res.ok || !data.data) throw new Error(data.error ?? "Comparison failed");
      setResult({ theme: data.data.modelA.result, model: selectedModel?.name ?? modelId });
      setResultB({ theme: data.data.modelB.result, model: models.find((m) => m.id === modelBId)?.name ?? modelBId });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
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
            <label className="block text-sm font-medium text-white/80 mb-1.5">
              LLM Model <span className="text-white/40">(top 10 providers via OpenRouter)</span>
            </label>
            <select
              value={modelId}
              onChange={(e) => {
                setModelChoice(e.target.value);
                setEffort("");
              }}
              className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id} className="bg-dark">
                  {modelOptionLabel(m)}
                </option>
              ))}
            </select>
            {selectedModel && (
              <p className="mt-1.5 text-xs text-white/50">{selectedModel.description}</p>
            )}
            <p className="mt-1 text-xs text-white/30">
              {models.some((m) => m.livePricing)
                ? "Live pricing from the OpenRouter catalogue (refreshed hourly)."
                : "OpenRouter catalogue unreachable — showing last-known pricing."}
            </p>
          </div>

          {/* Reasoning effort — only for models that support it */}
          {effortAvailable && (
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">
                Reasoning effort
              </label>
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                <option value="" className="bg-dark">Default (model decides)</option>
                <option value="low" className="bg-dark">Low — fastest, cheapest</option>
                <option value="medium" className="bg-dark">Medium — balanced</option>
                <option value="high" className="bg-dark">High — deepest thinking, most tokens</option>
              </select>
              <p className="mt-1 text-xs text-white/30">
                Higher effort spends more output tokens on reasoning before writing.
              </p>
            </div>
          )}

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
              <label className="block text-sm font-medium text-white/80 mb-1.5">Model B</label>
              <select
                value={modelBId}
                onChange={(e) => setModelBId(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                <option value="" className="bg-dark">Select model B…</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id} className="bg-dark">{modelOptionLabel(m)}</option>
                ))}
              </select>
              <Button onClick={handleCompare} disabled={loading || !shopId || !modelBId} className="mt-2 w-full">
                {loading && compareMode ? "Comparing…" : "Compare models"}
              </Button>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Right: Preview */}
        <div className={`flex-1 ${compareMode && result && resultB ? "grid grid-cols-2 gap-4" : ""}`}>
          {result ? (
            <BrandPreview theme={result.theme} modelLabel={result.model} />
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-white/20 text-sm text-white/30">
              Generate a theme to see a preview here
            </div>
          )}
          {compareMode && resultB && (
            <BrandPreview theme={resultB.theme} modelLabel={resultB.model} />
          )}
        </div>
      </div>
    </div>
  );
}

function BrandPreview({ theme, modelLabel }: { theme: BrandConfig; modelLabel: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-white/40 uppercase tracking-wider">Preview</p>
        <Badge variant="outline">{modelLabel}</Badge>
      </div>
      <div className="flex gap-3">
        <div className="flex flex-col items-center gap-1">
          <div className="h-10 w-10 rounded-full border border-white/10" style={{ background: theme.primaryColor }} />
          <p className="text-xs text-white/40">Primary</p>
        </div>
        <div className="flex flex-col items-center gap-1">
          <div className="h-10 w-10 rounded-full border border-white/10" style={{ background: theme.accentColor }} />
          <p className="text-xs text-white/40">Accent</p>
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
    </div>
  );
}
