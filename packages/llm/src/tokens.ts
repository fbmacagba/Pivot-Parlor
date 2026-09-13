import { parseModelId, type Route } from "./ids";

/** Per-slug caps carried over from the research and text workers. */
const SLUG_PREFIX_CAPS: Array<[prefix: string, cap: number]> = [
  ["meta-llama/", 4096],
  ["google/gemini-3.1-flash-lite", 8000],
];

const ROUTE_CAPS: Record<Route, number> = {
  openrouter: 16_384,
  openai: 16_384,
  anthropic: 16_384,
};

/** The output budget to send: the caller's request, clamped to the model's known cap. */
export function maxOutputTokensFor(id: string, requested: number): number {
  const { route, model } = parseModelId(id);
  const want = Math.max(1, Math.floor(requested));
  if (route === "openrouter") {
    const slug = model.toLowerCase();
    for (const [prefix, cap] of SLUG_PREFIX_CAPS) {
      if (slug.startsWith(prefix)) return Math.min(want, cap);
    }
  }
  return Math.min(want, ROUTE_CAPS[route]);
}
