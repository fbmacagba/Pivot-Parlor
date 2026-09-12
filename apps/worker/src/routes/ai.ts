import { Hono } from "hono";
import { safeJsonParse } from "@repo/utils";
import type { Bindings } from "../bindings.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import {
  generateShopTheme,
  persistShopTheme,
  validateBrandConfig,
  type ThemePalette,
} from "../services/ai-generator.js";
import {
  DEFAULT_THEME_MODEL,
  getLiveModels,
  parseTextEffort,
  providerKeysFromEnv,
} from "../services/model-registry.js";

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Owner palette from a request body — honoured only as a complete, valid pair. */
function parsePalette(body: { color_primary?: unknown; color_accent?: unknown }): ThemePalette | undefined {
  const primary =
    typeof body.color_primary === "string" && HEX6.test(body.color_primary.trim())
      ? body.color_primary.trim()
      : undefined;
  const accent =
    typeof body.color_accent === "string" && HEX6.test(body.color_accent.trim())
      ? body.color_accent.trim()
      : undefined;
  return primary && accent ? { primary, accent } : undefined;
}

const ai = new Hono<{ Bindings: Bindings }>();

// All AI routes require developer role
ai.use("*", authMiddleware, requireRole("developer"));

// AI generation is expensive — cap per user (cost abuse brake, NFR-S4)
ai.use(
  "*",
  rateLimit({
    name: "ai",
    limit: 10,
    windowS: 3600,
    key: (c) => getUser(c)?.sub ?? clientIp(c),
  })
);

// ─── GET /api/ai/models — three provider groups with live pricing (KV-cached 1 h) ───

ai.get("/models", async (c) => {
  return c.json({ success: true, data: await getLiveModels(c.env.KV, providerKeysFromEnv(c.env)) });
});

// ─── POST /api/ai/generate-theme — generate brand theme for a shop ────────────
// Body: { shop_id, model_id, style_keywords?, effort?, regenerate?,
//         color_primary?, color_accent?, preview? }
// preview: true returns the theme without persisting it — the caller applies
// the one it wants via /api/ai/apply-theme.

ai.post("/generate-theme", async (c) => {
  const body = await c.req.json<{
    shop_id?: string;
    model_id?: string;
    style_keywords?: string;
    effort?: string;
    regenerate?: boolean;
    color_primary?: string;
    color_accent?: string;
    preview?: boolean;
  }>();

  if (!body.shop_id) {
    return c.json({ success: false, error: "shop_id is required" }, 400);
  }
  if (body.effort !== undefined && body.effort !== "" && !parseTextEffort(body.effort)) {
    return c.json({ success: false, error: "effort must be low, medium or high" }, 400);
  }
  const effort = parseTextEffort(body.effort);
  const modelId = body.model_id ?? DEFAULT_THEME_MODEL;

  const shop = await c.env.DB.prepare(
    "SELECT id, name, type, ai_theme FROM shops WHERE id = ?"
  )
    .bind(body.shop_id)
    .first<{ id: string; name: string; type: string; ai_theme: string | null }>();

  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  // Return cached theme unless regenerate=true. A corrupt cache/stored value
  // falls through to regeneration rather than crashing.
  if (!body.regenerate) {
    const cached = safeJsonParse(await c.env.KV.get(`shop:theme:${shop.id}`));
    if (cached) {
      return c.json({ success: true, data: cached, cached: true, model_used: modelId });
    }
    const stored = safeJsonParse(shop.ai_theme);
    if (stored) {
      return c.json({ success: true, data: stored, cached: true, model_used: modelId });
    }
  }

  const theme = await generateShopTheme(
    shop.id,
    shop.name,
    shop.type,
    modelId,
    body.style_keywords,
    effort,
    c.env.DB,
    c.env.KV,
    providerKeysFromEnv(c.env),
    { palette: parsePalette(body), persist: body.preview !== true }
  );

  return c.json({ success: true, data: theme, cached: false, model_used: modelId });
});

// ─── POST /api/ai/apply-theme — persist a previously previewed theme ──────────
// Body: { shop_id, theme, model_id? }

ai.post("/apply-theme", async (c) => {
  const body = await c.req.json<{ shop_id?: string; model_id?: string; theme?: unknown }>();
  if (!body.shop_id) {
    return c.json({ success: false, error: "shop_id is required" }, 400);
  }
  const theme = validateBrandConfig(body.theme);
  if (!theme) {
    return c.json({ success: false, error: "theme is missing or invalid" }, 400);
  }

  const shop = await c.env.DB.prepare("SELECT id FROM shops WHERE id = ?")
    .bind(body.shop_id)
    .first<{ id: string }>();
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const modelId = typeof body.model_id === "string" && body.model_id.trim() ? body.model_id.trim() : "manual";
  await persistShopTheme(c.env.DB, c.env.KV, shop.id, modelId, theme);
  return c.json({ success: true, data: theme });
});

// ─── POST /api/ai/compare — generate with two models side by side ─────────────
// Body: { shop_id, model_a_id, model_b_id, style_keywords? }

ai.post("/compare", async (c) => {
  const body = await c.req.json<{
    shop_id?: string;
    model_a_id?: string;
    model_b_id?: string;
    style_keywords?: string;
    effort?: string;
    color_primary?: string;
    color_accent?: string;
  }>();

  if (!body.shop_id || !body.model_a_id || !body.model_b_id) {
    return c.json(
      { success: false, error: "shop_id, model_a_id and model_b_id are required" },
      400
    );
  }
  if (body.effort !== undefined && body.effort !== "" && !parseTextEffort(body.effort)) {
    return c.json({ success: false, error: "effort must be low, medium or high" }, 400);
  }
  const effort = parseTextEffort(body.effort);

  const shop = await c.env.DB.prepare(
    "SELECT id, name, type FROM shops WHERE id = ?"
  )
    .bind(body.shop_id)
    .first<{ id: string; name: string; type: string }>();

  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  // Comparisons are ALWAYS previews: persisting both sides made the slower
  // model silently win. The caller applies its pick via /api/ai/apply-theme.
  const options = { palette: parsePalette(body), persist: false as const };
  const [resultA, resultB] = await Promise.allSettled([
    generateShopTheme(
      shop.id,
      shop.name,
      shop.type,
      body.model_a_id,
      body.style_keywords,
      effort,
      c.env.DB,
      c.env.KV,
      providerKeysFromEnv(c.env),
      options
    ),
    generateShopTheme(
      shop.id,
      shop.name,
      shop.type,
      body.model_b_id,
      body.style_keywords,
      effort,
      c.env.DB,
      c.env.KV,
      providerKeysFromEnv(c.env),
      options
    ),
  ]);

  return c.json({
    success: true,
    data: {
      model_a: {
        id: body.model_a_id,
        theme: resultA.status === "fulfilled" ? resultA.value : null,
        error: resultA.status === "rejected" ? (resultA.reason as Error).message : null,
      },
      model_b: {
        id: body.model_b_id,
        theme: resultB.status === "fulfilled" ? resultB.value : null,
        error: resultB.status === "rejected" ? (resultB.reason as Error).message : null,
      },
    },
  });
});

export default ai;
