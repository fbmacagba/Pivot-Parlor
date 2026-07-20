/**
 * OpenRouter image models: Gemini (modalities + image_config + data URLs) vs
 * FLUX (plain chat body, image URL in response.data[0].url or message).
 */

export const OPENROUTER_IMAGE_MODEL = "google/gemini-3.1-flash-image";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Gemini / nano-banana style models on OpenRouter. */
export function isGeminiStyleImageModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("google/");
}

/** FLUX and similar on OpenRouter — no modalities / image_config. */
export function isFluxStyleImageModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("black-forest-labs/");
}

/** Shorten data URLs and huge base64-like strings for logs (full response can be MB+). */
export function truncateOpenRouterResponseForLog(raw: string, maxLen = 14_000): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const summarized = JSON.stringify(parsed, truncateJsonReplacer);
    if (summarized.length <= maxLen) return summarized;
    return `${summarized.slice(0, maxLen)}…[truncated, total ${summarized.length}]`;
  } catch {
    if (raw.length <= maxLen) return raw;
    return `${raw.slice(0, maxLen)}…[truncated, total ${raw.length}]`;
  }
}

function truncateJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= 200) return value;
  if (value.startsWith("data:image/")) {
    const comma = value.indexOf(",");
    const head = comma >= 0 ? value.slice(0, Math.min(comma + 40, value.length)) : value.slice(0, 80);
    return `${head}…[data URL len=${value.length}]`;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 120) {
    return `${value.slice(0, 60)}…[base64-like len=${value.length}]`;
  }
  if (value.length > 500) return `${value.slice(0, 200)}…[len=${value.length}]`;
  return value;
}

function logMessageShapeForDebug(message: unknown, logPrefix: string): void {
  try {
    const s = JSON.stringify(message, truncateJsonReplacer, 2);
    console.error(`${logPrefix} choices[0].message (truncated):`, s.slice(0, 8000));
  } catch (e) {
    console.error(`${logPrefix} could not stringify message:`, e);
  }
}

function normalizeContentParts(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") {
    const t = content.trim();
    if (t.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* ignore */
      }
    }
  }
  return [];
}

/**
 * Extract data:image/...;base64,... or https image URL from OpenRouter chat message.
 * FLUX may return https URLs in image_url parts or plain text content.
 */
export function extractDataImageUrlFromOpenRouterMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;

  const legacy = m.images;
  if (Array.isArray(legacy)) {
    const first = legacy[0];
    if (first && typeof first === "object") {
      const url = (first as { image_url?: { url?: string } }).image_url?.url;
      if (typeof url === "string" && (url.startsWith("data:image/") || isHttpImageUrl(url))) return url;
    }
  }

  const content = m.content;
  if (typeof content === "string") {
    const t = content.trim();
    if (isHttpImageUrl(t)) return t;
  }

  const parts = normalizeContentParts(content);
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "image_url" && p.image_url && typeof p.image_url === "object") {
      const url = (p.image_url as { url?: string }).url;
      if (typeof url === "string" && (url.startsWith("data:image/") || isHttpImageUrl(url))) return url;
    }
  }
  return null;
}

function isHttpImageUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/**
 * FLUX-style OpenRouter responses: top-level `data` array with `{ url }` (HTTP image link).
 */
export function extractFluxHttpImageUrlFromOpenRouterJson(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const dataArr = root.data;
  if (Array.isArray(dataArr) && dataArr.length > 0) {
    const first = dataArr[0];
    if (first && typeof first === "object") {
      const url = (first as { url?: string }).url;
      if (typeof url === "string" && isHttpImageUrl(url)) return url;
    }
  }
  return null;
}

function uint8ToArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

export function dataImageUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("Expected data:image/ URL");
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid data URL (no comma)");
  const meta = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1).replace(/\s/g, "");
  if (!b64) throw new Error("Empty base64 payload");
  if (meta.includes(";base64")) {
    const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return uint8ToArrayBuffer(binary);
  }
  const decoded = decodeURIComponent(b64);
  return uint8ToArrayBuffer(new TextEncoder().encode(decoded));
}

async function fetchHttpImageToArrayBuffer(imageUrl: string, logPrefix: string): Promise<ArrayBuffer> {
  let imgRes: Response;
  try {
    imgRes = await fetch(imageUrl, {
      headers: { Accept: "image/*,*/*" },
    });
  } catch (e) {
    console.error(`${logPrefix} failed to fetch image URL:`, imageUrl.slice(0, 200), e);
    throw new Error(`Failed to fetch image from URL: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!imgRes.ok) {
    const t = await imgRes.text().catch(() => "");
    console.error(`${logPrefix} image URL fetch not ok`, {
      status: imgRes.status,
      urlPreview: imageUrl.slice(0, 200),
      bodyPreview: t.slice(0, 500),
    });
    throw new Error(`Image URL returned HTTP ${imgRes.status}`);
  }
  const buf = await imgRes.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    throw new Error("Downloaded image is empty");
  }
  return buf;
}

function buildOpenRouterRequestBody(
  model: string,
  prompt: string,
  aspectRatio: string
): Record<string, unknown> {
  if (isFluxStyleImageModel(model)) {
    return {
      model,
      messages: [{ role: "user", content: prompt }],
    };
  }
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    modalities: ["image", "text"],
    image_config: { aspect_ratio: aspectRatio },
  };
}

export async function generateOpenRouterImageBuffer(
  prompt: string,
  aspectRatio: string,
  apiKey: string,
  logPrefix = "[site-gen][image]",
  model?: string
): Promise<ArrayBuffer> {
  const resolvedModel = (model && model.trim()) || OPENROUTER_IMAGE_MODEL;
  const requestBody = buildOpenRouterRequestBody(resolvedModel, prompt, aspectRatio);

  console.log(`${logPrefix} OpenRouter request body:`, JSON.stringify(requestBody));

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://pivotparlor.com",
        "X-Title": "Pivot Parlor",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    console.error(`${logPrefix} OpenRouter fetch failed:`, e);
    throw e;
  }

  const responseText = await res.text();
  console.log(
    `${logPrefix} OpenRouter response status=${res.status}, body (truncated/summarized):`,
    truncateOpenRouterResponseForLog(responseText)
  );

  if (!res.ok) {
    console.error(
      `${logPrefix} OpenRouter error: status=${res.status} statusText=${res.statusText} full body:\n${responseText}`
    );
    throw new Error(`OpenRouter image error ${res.status}: ${responseText.slice(0, 800)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(responseText);
  } catch (e) {
    console.error(`${logPrefix} Failed to parse OpenRouter JSON:`, e);
    throw new Error("OpenRouter image response was not valid JSON");
  }

  const message = (data as { choices?: Array<{ message?: unknown }> })?.choices?.[0]?.message;

  if (isFluxStyleImageModel(resolvedModel)) {
    let httpUrl = extractFluxHttpImageUrlFromOpenRouterJson(data);
    if (!httpUrl) {
      httpUrl = extractDataImageUrlFromOpenRouterMessage(message);
    }
    if (httpUrl && isHttpImageUrl(httpUrl)) {
      return fetchHttpImageToArrayBuffer(httpUrl, logPrefix);
    }
    if (httpUrl && httpUrl.startsWith("data:image/")) {
      return dataImageUrlToArrayBuffer(httpUrl);
    }
    console.error(`${logPrefix} FLUX: no HTTP or data image URL in response; dumping shapes`);
    console.error(`${logPrefix} parsed top-level keys:`, data && typeof data === "object" ? Object.keys(data as object) : []);
    logMessageShapeForDebug(message, logPrefix);
    throw new Error("No image URL in OpenRouter response (expected data[0].url or message image content)");
  }

  const dataUrl = extractDataImageUrlFromOpenRouterMessage(message);
  if (!dataUrl) {
    console.error(`${logPrefix} No image URL in response; dumping message shape`);
    logMessageShapeForDebug(message, logPrefix);
    throw new Error("No image in OpenRouter response (check content[].type === image_url)");
  }

  if (isHttpImageUrl(dataUrl)) {
    return fetchHttpImageToArrayBuffer(dataUrl, logPrefix);
  }

  try {
    return dataImageUrlToArrayBuffer(dataUrl);
  } catch (e) {
    console.error(`${logPrefix} Failed to decode image data URL:`, e);
    throw e instanceof Error ? e : new Error(String(e));
  }
}
