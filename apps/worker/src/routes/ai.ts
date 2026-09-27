import { Hono } from "hono";
import { safeJsonParse } from "@repo/utils";
import { AuditWriteError } from "@repo/audit";
import type { Bindings } from "../bindings.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { requireRole } from "../middleware/rbac.js";
import { clientIp, rateLimit } from "../middleware/rate-limit.js";
import { auditFor, auditRefused } from "../audit/context.js";
import {
  generateShopTheme,
  persistShopTheme,
  validateBrandConfig,
  type BrandConfig,
  type ThemePalette,
} from "../services/ai-generator.js";
import {
  DEFAULT_THEME_MODEL,
  getLiveModels,
  getModel,
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

// ─── Read and settings routes: registered BEFORE the generation rate limiter ───
// Hono runs handlers in registration order and stops at the first response,
// so these cheap KV reads/writes never consume the 10/hour generation budget.

// GET /api/ai/models — three provider groups with live pricing (KV-cached 1 h)
ai.get("/models", async (c) => {
  return c.json({ success: true, data: await getLiveModels(c.env.KV, providerKeysFromEnv(c.env)) });
});

/** Platform-wide chatbot model choice: `{ model_id, updated_at }`, no expiry. */
export const CHATBOT_MODEL_KV_KEY = "platform:chatbot:model";

// GET /api/ai/chatbot-model — current platform-wide chatbot model (nulls when unset)
ai.get("/chatbot-model", async (c) => {
  const stored = safeJsonParse<{ model_id?: unknown; updated_at?: unknown }>(await c.env.KV.get(CHATBOT_MODEL_KV_KEY));
  return c.json({
    success: true,
    data: {
      model_id: typeof stored?.model_id === "string" ? stored.model_id : null,
      updated_at: typeof stored?.updated_at === "string" ? stored.updated_at : null,
    },
  });
});

// POST /api/ai/chatbot-model — body { model_id }; must be a listed text model
ai.post("/chatbot-model", async (c) => {
  const body = await c.req.json<{ model_id?: unknown }>().catch(() => ({}) as { model_id?: unknown });
  const modelId = typeof body.model_id === "string" ? body.model_id.trim() : "";
  if (!modelId) return c.json({ success: false, error: "model_id is required" }, 400);
  const model = await getModel(c.env.KV, providerKeysFromEnv(c.env), modelId, "text");
  if (!model) return c.json({ success: false, error: `Unknown text model: ${modelId}` }, 400);
  const record = { model_id: modelId, updated_at: new Date().toISOString() };
  const previous = safeJsonParse<{ model_id?: unknown }>(await c.env.KV.get(CHATBOT_MODEL_KV_KEY));
  try {
    await auditFor(c).run(
      {
        action: "ai.chatbot_model.set",
        entityType: "platform_setting",
        entityId: "chatbot_model",
        changes: { chatbot_model: [typeof previous?.model_id === "string" ? previous.model_id : null, modelId] },
      },
      () => c.env.KV.put(CHATBOT_MODEL_KV_KEY, JSON.stringify(record))
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
  return c.json({ success: true, data: record });
});

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
  // A blank or whitespace model_id means "not chosen": fall back to the default
  // instead of letting an empty id slip past validation into the generator.
  const requestedModel = typeof body.model_id === "string" ? body.model_id.trim() : "";
  const modelId = requestedModel || DEFAULT_THEME_MODEL;
  if (requestedModel && !(await getModel(c.env.KV, providerKeysFromEnv(c.env), requestedModel, "text"))) {
    return c.json({ success: false, error: `Unknown text model: ${requestedModel}` }, 400);
  }

  const shop = await c.env.DB.prepare(
    "SELECT id, name, type, ai_theme FROM shops WHERE id = ?"
  )
    .bind(body.shop_id)
    .first<{ id: string; name: string; type: string; ai_theme: string | null }>();

  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);

  const audit = auditFor(c);
  try {
    // Return cached theme unless regenerate=true. A corrupt cache/stored value
    // falls through to regeneration rather than crashing.
    if (!body.regenerate) {
      const cached = safeJsonParse(await c.env.KV.get(`shop:theme:${shop.id}`)) ?? safeJsonParse(shop.ai_theme);
      if (cached) {
        await audit.write({ action: "theme.generate", outcome: "succeeded", shopId: shop.id, entityType: "theme", entityId: shop.id, details: { cached: true, model: modelId } });
        return c.json({ success: true, data: cached, cached: true, model_used: modelId });
      }
    }
    const theme = await audit.run(
      { action: "theme.generate", shopId: shop.id, entityType: "theme", entityId: shop.id, details: { model: modelId, preview: body.preview === true } },
      () =>
        generateShopTheme(shop.id, shop.name, shop.type, modelId, body.style_keywords, effort, c.env.DB, c.env.KV, providerKeysFromEnv(c.env), {
          palette: parsePalette(body),
          persist: body.preview !== true,
          audit,
        })
    );
    return c.json({ success: true, data: theme, cached: false, model_used: modelId });
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
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
  try {
    await persistShopTheme(c.env.DB, c.env.KV, shop.id, modelId, theme, { recorder: auditFor(c), fallback: false });
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
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

  const keys = providerKeysFromEnv(c.env);
  // Never log the raw request-body model ids verbatim (Ruling 14): only a
  // listed model's own id, or null when it isn't one. The unvalidated raw
  // id is still used below to actually drive generation — an unknown side
  // fails on its own inside generateShopTheme (Unknown model), reported as
  // that side's `error`, same as before this task.
  const auditModelId = async (id: unknown): Promise<string | null> => {
    if (typeof id !== "string") return null;
    const model = await getModel(c.env.KV, keys, id, "text");
    return model ? model.id : null;
  };
  const [modelAForAudit, modelBForAudit] = await Promise.all([
    auditModelId(body.model_a_id),
    auditModelId(body.model_b_id),
  ]);

  // Comparisons are ALWAYS previews: persisting both sides made the slower
  // model silently win. The caller applies its pick via /api/ai/apply-theme.
  const audit = auditFor(c);
  const options = { palette: parsePalette(body), persist: false as const, audit };
  let resultA: PromiseSettledResult<BrandConfig>;
  let resultB: PromiseSettledResult<BrandConfig>;
  try {
    [resultA, resultB] = await audit.run(
      { action: "theme.compare", shopId: shop.id, entityType: "theme", entityId: shop.id, details: { model_a: modelAForAudit, model_b: modelBForAudit } },
      async () => {
        const settled = await Promise.allSettled([
          generateShopTheme(shop.id, shop.name, shop.type, body.model_a_id!, body.style_keywords, effort, c.env.DB, c.env.KV, keys, options),
          generateShopTheme(shop.id, shop.name, shop.type, body.model_b_id!, body.style_keywords, effort, c.env.DB, c.env.KV, keys, options),
        ]);
        // allSettled swallows a rejection, including an AuditWriteError from
        // either side's own "ai.call" audit write (Ruling 9): surface it so
        // this whole comparison refuses (503) instead of a silent 200 that
        // hides an unrecorded audit attempt.
        const auditFailure = settled.find(
          (r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof AuditWriteError
        );
        if (auditFailure) throw auditFailure.reason;
        return settled;
      }
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }

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
