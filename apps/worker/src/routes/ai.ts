import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { authMiddleware } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { generateShopTheme } from "../services/ai-generator.js";
import { MODEL_REGISTRY } from "../services/model-registry.js";

const ai = new Hono<{ Bindings: Bindings }>();

// All AI routes require developer role
ai.use("*", authMiddleware, requireRole("developer"));

// ─── GET /api/ai/models — return full model registry ─────────────────────────

ai.get("/models", (c) => {
  return c.json({ success: true, data: MODEL_REGISTRY });
});

// ─── POST /api/ai/generate-theme — generate brand theme for a shop ────────────
// Body: { shop_id, model_id, style_keywords?, regenerate? }

ai.post("/generate-theme", async (c) => {
  const body = await c.req.json<{
    shop_id?: string;
    model_id?: string;
    style_keywords?: string;
    regenerate?: boolean;
  }>();

  if (!body.shop_id) {
    return c.json({ success: false, error: "shop_id is required" }, 400);
  }
  const modelId = body.model_id ?? "claude-sonnet-4-6";

  const shop = await c.env.DB.prepare(
    "SELECT id, name, type, ai_theme FROM shops WHERE id = ?"
  )
    .bind(body.shop_id)
    .first<{ id: string; name: string; type: string; ai_theme: string | null }>();

  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  // Return cached theme unless regenerate=true
  if (!body.regenerate) {
    const cached = await c.env.KV.get(`shop:theme:${shop.id}`);
    if (cached) {
      return c.json({ success: true, data: JSON.parse(cached), cached: true, model_used: modelId });
    }
    if (shop.ai_theme) {
      return c.json({ success: true, data: JSON.parse(shop.ai_theme), cached: true, model_used: modelId });
    }
  }

  const theme = await generateShopTheme(
    shop.id,
    shop.name,
    shop.type,
    modelId,
    body.style_keywords,
    c.env.DB,
    c.env.KV,
      c.env.OPENROUTER_API_KEY,
      c.env.GOOGLE_AI_API_KEY
    );

  return c.json({ success: true, data: theme, cached: false, model_used: modelId });
});

// ─── POST /api/ai/compare — generate with two models side by side ─────────────
// Body: { shop_id, model_a_id, model_b_id, style_keywords? }

ai.post("/compare", async (c) => {
  const body = await c.req.json<{
    shop_id?: string;
    model_a_id?: string;
    model_b_id?: string;
    style_keywords?: string;
  }>();

  if (!body.shop_id || !body.model_a_id || !body.model_b_id) {
    return c.json(
      { success: false, error: "shop_id, model_a_id and model_b_id are required" },
      400
    );
  }

  const shop = await c.env.DB.prepare(
    "SELECT id, name, type FROM shops WHERE id = ?"
  )
    .bind(body.shop_id)
    .first<{ id: string; name: string; type: string }>();

  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const [resultA, resultB] = await Promise.allSettled([
    generateShopTheme(
      shop.id,
      shop.name,
      shop.type,
      body.model_a_id,
      body.style_keywords,
      c.env.DB,
      c.env.KV,
      c.env.OPENROUTER_API_KEY,
      c.env.GOOGLE_AI_API_KEY
    ),
    generateShopTheme(
      shop.id,
      shop.name,
      shop.type,
      body.model_b_id,
      body.style_keywords,
      c.env.DB,
      c.env.KV,
      c.env.OPENROUTER_API_KEY,
      c.env.GOOGLE_AI_API_KEY
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
