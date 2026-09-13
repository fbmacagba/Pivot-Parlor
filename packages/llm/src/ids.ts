/** Which API a model id is called through. */
export type Route = "openrouter" | "openai" | "anthropic";

export interface ParsedModelId {
  route: Route;
  /** For direct routes the vendor's model id; for OpenRouter the full slug. */
  model: string;
}

const OPENAI_PREFIX = "openai-api/";
const ANTHROPIC_PREFIX = "anthropic-api/";

function checked(route: Route, model: string, original: string): ParsedModelId {
  const trimmed = model.trim();
  if (!trimmed) throw new Error(`Malformed model id: "${original}"`);
  return { route, model: trimmed };
}

/**
 * Split a route-qualified id. `openai-api/X` and `anthropic-api/X` are the
 * direct routes; everything else is an OpenRouter slug used verbatim.
 * Throws on an empty model part (validation rejects such ids upstream).
 */
export function parseModelId(id: string): ParsedModelId {
  const trimmed = (id ?? "").trim();
  if (trimmed.startsWith(OPENAI_PREFIX)) return checked("openai", trimmed.slice(OPENAI_PREFIX.length), id);
  if (trimmed.startsWith(ANTHROPIC_PREFIX)) {
    return checked("anthropic", trimmed.slice(ANTHROPIC_PREFIX.length), id);
  }
  return checked("openrouter", trimmed, id);
}

export function isValidModelId(id: string): boolean {
  try {
    parseModelId(id);
    return true;
  } catch {
    return false;
  }
}

/** The OpenRouter slug that carries a model's price (identity for OpenRouter ids). */
export function priceTwin(id: string): string {
  const { route, model } = parseModelId(id);
  if (route === "openai") return `openai/${model}`;
  if (route === "anthropic") return `anthropic/${model}`;
  return model;
}
