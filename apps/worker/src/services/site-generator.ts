import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import {
  getShopById,
  getShopBySlug,
  getShopSiteByShopId,
  createShopSite,
} from "../db/queries.js";
import { generateOpenRouterImageBuffer } from "./openrouter-image-generation.js";

const TEXT_MODEL = "google/gemini-3.1-flash-lite-preview";
const SITE_KV_TTL = 60 * 60 * 24; // 24h

export interface SiteService {
  name: string;
  duration_minutes: number;
  price_gbp: number;
  description: string;
}

export interface GeneratedSite {
  template: string;
  headline: string;
  tagline: string;
  about: string;
  services: SiteService[];
  color_primary: string;
  color_accent: string;
  font_heading: string;
  font_body: string;
  hero_image_url: string;
  logo_url: string;
  catalog_images: string[];
}

interface TextGenOutput {
  headline: string;
  tagline: string;
  about: string;
  services: Array<{ name: string; duration_minutes: number; price_gbp: number; description: string }>;
  color_primary: string;
  color_accent: string;
  font_heading: string;
  font_body: string;
  template: string;
  logo_concept: string;
  hero_concept: string;
  catalog_concepts: string[];
}

export interface GenerateSiteOptions {
  template?: string;
  color_primary?: string;
  color_accent?: string;
  design_notes?: string;
  logoFile?: File;
}

// ─── Text generation via OpenRouter ───────────────────────────────────────────

async function generateText(
  shopName: string,
  shopType: string,
  designNotes: string | undefined,
  apiKey: string
): Promise<TextGenOutput> {
  const typeLabel = shopType.replace(/_/g, " ");
  const notes = designNotes?.trim() || "not provided";
  const prompt = `You are an expert brand strategist for beauty and grooming businesses.

Shop name: ${shopName}. Type: ${typeLabel}. Owner style notes: ${notes}. Generate content that matches this vibe.

Return ONLY valid JSON with exactly these keys (no markdown, no explanation):
{
  "headline": "4-7 words, bold, attention-grabbing",
  "tagline": "5-8 words, benefit-led",
  "about": "2 sentences describing the shop",
  "services": [
    { "name": "Service name", "duration_minutes": 30, "price_gbp": 25, "description": "Brief description" }
  ],
  "color_primary": "hex colour (e.g. #1A1A1A, #0D0D0D, #2D1B4E)",
  "color_accent": "hex colour (e.g. #C9A84C, #E07C5C)",
  "font_heading": "Google Font name (e.g. Playfair Display, Cormorant Garamond)",
  "font_body": "Google Font name (e.g. DM Sans, Inter)",
  "template": "minimal" | "luxury" | "vibrant" | "editorial" | "classic" | "fresh",
  "logo_concept": "Short description for logo image: clean professional logo on white, 1-2 sentences",
  "hero_concept": "Short description for hero image: photorealistic barbershop/salon atmosphere, 1-2 sentences",
  "catalog_concepts": ["Description for service 1 image", "Description for service 2 image", ...]
}

Ensure catalog_concepts has one entry per service.`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://pivotparlor.com",
      "X-Title": "Pivot Parlor",
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return ONLY valid JSON, no markdown." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Text API error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = (data.choices[0]?.message?.content ?? "{}").trim().replace(/```json|```/g, "").trim();
  return JSON.parse(raw) as TextGenOutput;
}

// ─── Image generation via OpenRouter (Gemini image model) ──────────────────────

async function generateImage(prompt: string, aspectRatio: string, apiKey: string): Promise<ArrayBuffer> {
  return generateOpenRouterImageBuffer(prompt, aspectRatio, apiKey, "[site-generator][image]");
}

// ─── Upload to R2 ─────────────────────────────────────────────────────────────

async function uploadToR2(
  r2: R2Bucket,
  key: string,
  body: ArrayBuffer,
  contentType: string
): Promise<void> {
  await r2.put(key, body, {
    httpMetadata: { contentType },
  });
}

// ─── Main generator ───────────────────────────────────────────────────────────

export async function generateShopSite(
  shopId: string,
  shopSlug: string,
  apiBaseUrl: string,
  db: D1Database,
  kv: KVNamespace,
  r2: R2Bucket,
  openrouterKey: string,
  options: GenerateSiteOptions
): Promise<GeneratedSite> {
  const existing = await getShopSiteByShopId(db, shopId);
  if (existing) throw new Error("Site already exists for this shop");

  const shop = await getShopById(db, shopId);
  if (!shop) throw new Error("Shop not found");

  const validTemplates = ["minimal", "luxury", "vibrant", "editorial", "classic", "fresh"];
  // Owner template overrides AI; when not provided (dev flow), AI chooses
  const ownerTemplate = options.template && validTemplates.includes(options.template) ? options.template : null;

  // Step 1: Text generation (with design notes)
  const text = await generateText(shop.name, shop.type, options.design_notes, openrouterKey);
  const template = ownerTemplate ?? (validTemplates.includes(text.template) ? text.template : "minimal");

  const r2Prefix = `shops/${shopSlug}`;

  // Owner colours override AI
  const colorPrimary = options.color_primary || text.color_primary;
  const colorAccent = options.color_accent || text.color_accent;

  // Step 2: Image generation — hero and catalog use design notes; logo skipped if uploaded
  const styleContext = options.design_notes ? ` Style: ${options.design_notes}.` : "";
  const heroConcept = (text.hero_concept || `Photorealistic ${shop.type.replace(/_/g, " ")} interior`) + styleContext;
  const logoConcept = text.logo_concept || `Clean professional logo for ${shop.name} on white background`;
  const catalogConcepts = text.catalog_concepts?.length >= text.services.length
    ? text.catalog_concepts.map((c) => c + styleContext)
    : text.services.map((s) => `Professional ${s.name} service, clean product shot` + styleContext);

  const skipLogo = options.logoFile && options.logoFile.size > 0;

  const imagePromises: Promise<ArrayBuffer>[] = [
    generateImage(heroConcept, "4:1", openrouterKey),
    ...(skipLogo ? [] : [generateImage(logoConcept, "1:1", openrouterKey)]),
    ...catalogConcepts.slice(0, text.services.length).map((c) =>
      generateImage(`Clean product or style shot: ${c}`, "1:1", openrouterKey)
    ),
  ];

  const imageResults = await Promise.allSettled(imagePromises);

  const rHero = imageResults[0];
  const heroBuf = rHero?.status === "fulfilled" ? rHero.value : null;
  const rLogo = imageResults[1];
  const logoBuf = !skipLogo && rLogo?.status === "fulfilled" ? rLogo.value : null;
  const catalogStart = skipLogo ? 1 : 2;
  const catalogBufs = imageResults.slice(catalogStart).map((r) => (r?.status === "fulfilled" ? r.value : null));

  if (rHero?.status === "rejected") console.error("[site-gen] Hero image failed:", rHero.reason);
  if (!skipLogo && rLogo?.status === "rejected") console.error("[site-gen] Logo image failed:", rLogo.reason);

  // Step 3: Upload to R2
  let heroUrl: string | null = null;
  let logoUrl: string | null = null;

  if (heroBuf) {
    await uploadToR2(r2, `${r2Prefix}/hero.png`, heroBuf, "image/png");
    heroUrl = `${apiBaseUrl}/assets/${shopSlug}/hero.png`;
  }

  if (skipLogo && options.logoFile) {
    const ext = options.logoFile.name.match(/\.(png|jpg|jpeg|svg)$/i)?.[1] ?? "png";
    const contentType = options.logoFile.type || (ext === "svg" ? "image/svg+xml" : "image/png");
    const buf = await options.logoFile.arrayBuffer();
    await uploadToR2(r2, `${r2Prefix}/logo.${ext}`, buf, contentType);
    logoUrl = `${apiBaseUrl}/assets/${shopSlug}/logo.${ext}`;
  } else if (logoBuf) {
    await uploadToR2(r2, `${r2Prefix}/logo.png`, logoBuf, "image/png");
    logoUrl = `${apiBaseUrl}/assets/${shopSlug}/logo.png`;
  }

  const catalogUrls: string[] = [];
  for (let i = 0; i < catalogBufs.length; i++) {
    if (catalogBufs[i]) {
      await uploadToR2(r2, `${r2Prefix}/catalog-${i}.png`, catalogBufs[i]!, "image/png");
      catalogUrls.push(`${apiBaseUrl}/assets/${shopSlug}/catalog-${i}.png`);
    }
  }

  // Step 4: Save to D1
  const siteId = crypto.randomUUID();
  const servicesJson = JSON.stringify(
    text.services.map((s) => ({
      name: s.name,
      duration_minutes: s.duration_minutes,
      price_gbp: s.price_gbp,
      description: s.description,
    }))
  );

  await createShopSite(db, {
    id: siteId,
    shop_id: shopId,
    template,
    headline: text.headline,
    tagline: text.tagline,
    about: text.about,
    services_json: servicesJson,
    color_primary: colorPrimary,
    color_accent: colorAccent,
    font_heading: text.font_heading,
    font_body: text.font_body,
    hero_image_url: heroUrl,
    logo_url: logoUrl,
    catalog_images_json: JSON.stringify(catalogUrls),
    generated_at: new Date().toISOString(),
    status: "active",
    design_notes: options.design_notes || null,
    owner_color_primary: options.color_primary || null,
    owner_color_accent: options.color_accent || null,
    website_status: "live",
  });

  // Step 5: Cache in KV
  const siteObj: GeneratedSite = {
    template,
    headline: text.headline,
    tagline: text.tagline,
    about: text.about,
    services: text.services.map((s) => ({
      name: s.name,
      duration_minutes: s.duration_minutes,
      price_gbp: s.price_gbp,
      description: s.description,
    })),
    color_primary: colorPrimary,
    color_accent: colorAccent,
    font_heading: text.font_heading,
    font_body: text.font_body,
    hero_image_url: heroUrl ?? "",
    logo_url: logoUrl ?? "",
    catalog_images: catalogUrls,
  };

  await kv.put(`site:${shopSlug}`, JSON.stringify(siteObj), { expirationTtl: SITE_KV_TTL });

  return siteObj;
}
