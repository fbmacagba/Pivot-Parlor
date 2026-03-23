/**
 * pivot-parlor-audit — Final site generation step: quality checks → activate site or fail job.
 */
import type { D1Database, KVNamespace, MessageBatch, Queue } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ENVIRONMENT: string;
  /** Producer for deferred real image generation (optional — log if unbound). */
  site_images_queue?: Queue;
}

export interface AuditQueueMessage {
  jobId: string;
  shopId: string;
  shopSlug: string;
  shopName: string;
}

const HEX6 = /^#[0-9A-Fa-f]{6}$/;
const LEGAL_MIN_LEN = 100;
const SITE_CACHE_TTL_SEC = 86400;

function jobKvKey(jobId: string): string {
  return `job:${jobId}`;
}

function siteKvKey(shopSlug: string): string {
  return `site:${shopSlug}`;
}

function d1Rows<T>(r: unknown): T[] {
  if (r && typeof r === "object" && "results" in r && Array.isArray((r as { results: T[] }).results)) {
    return (r as { results: T[] }).results;
  }
  return [];
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function updateGenerationJob(
  db: D1Database,
  id: string,
  patch: {
    status?: string;
    stage?: string;
    audit_output?: string | null;
    error?: string | null;
  }
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [new Date().toISOString()];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.stage !== undefined) {
    sets.push("stage = ?");
    vals.push(patch.stage);
  }
  if (patch.audit_output !== undefined) {
    sets.push("audit_output = ?");
    vals.push(patch.audit_output);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    vals.push(patch.error);
  }
  vals.push(id);
  await db.prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
}

function parseJsonArrayField(raw: unknown): { ok: true; arr: unknown[] } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: false };
  if (typeof raw !== "string") return { ok: false };
  const t = raw.trim();
  if (t === "") return { ok: false };
  try {
    const v: unknown = JSON.parse(t);
    if (!Array.isArray(v)) return { ok: false };
    return { ok: true, arr: v };
  } catch {
    return { ok: false };
  }
}

/**
 * Run all 12 checks; hardFailures stop activation, warnings are logged only.
 * Legal pages and empty hero/logo URLs are warnings only (deferred image pass may fill assets).
 */
function runQualityChecks(
  shopSite: Record<string, unknown> | null,
  pages: Record<string, unknown>[],
  settings: Record<string, unknown> | null,
  shop: Record<string, unknown> | null
): { hardFailures: string[]; warnings: string[] } {
  const hardFailures: string[] = [];
  const warnings: string[] = [];

  // CHECK 1 — shop_sites record exists
  if (!shopSite) {
    hardFailures.push("shop_sites record missing for shopId");
  }

  // CHECK 2 — required text fields
  if (shopSite) {
    const missing: string[] = [];
    if (!nonEmptyString(shopSite.headline)) missing.push("headline");
    if (!nonEmptyString(shopSite.tagline)) missing.push("tagline");
    if (!nonEmptyString(shopSite.about)) missing.push("about");
    if (missing.length) {
      hardFailures.push(`Missing required text fields: [${missing.join(", ")}]`);
    }
  }

  // CHECK 3 — SEO fields
  if (shopSite) {
    if (!nonEmptyString(shopSite.seo_title) || !nonEmptyString(shopSite.seo_description)) {
      hardFailures.push("Missing SEO fields");
    }
  }

  // CHECK 4 — colour palette
  if (shopSite) {
    const cp = shopSite.color_primary;
    const ca = shopSite.color_accent;
    if (typeof cp !== "string" || !HEX6.test(cp) || typeof ca !== "string" || !HEX6.test(ca)) {
      hardFailures.push("Invalid colour values");
    }
  }

  // CHECK 5 — hero image (warning only)
  if (shopSite && !nonEmptyString(shopSite.hero_image_url)) {
    warnings.push("hero_image_url is empty — image generation may have failed or not yet completed");
  }

  // CHECK 5b — logo (warning only)
  if (shopSite && !nonEmptyString(shopSite.logo_url)) {
    warnings.push("logo_url is empty — image generation may have failed or not yet completed");
  }

  // CHECK 6 — services JSON
  if (shopSite) {
    const raw = shopSite.services_json;
    if (raw === null || raw === undefined) {
      hardFailures.push("services_json is not valid JSON");
    } else if (typeof raw !== "string") {
      hardFailures.push("services_json is not valid JSON");
    } else {
      try {
        const v: unknown = JSON.parse(raw);
        if (!Array.isArray(v)) {
          hardFailures.push("services_json is not valid JSON");
        }
      } catch {
        hardFailures.push("services_json is not valid JSON");
      }
    }
  }

  // CHECK 7 — legal pages (warnings only)
  const byType = new Map<string, Record<string, unknown>>();
  for (const p of pages) {
    const t = p.page_type;
    if (typeof t === "string") byType.set(t, p);
  }
  const need = ["privacy", "terms", "cookies"] as const;
  const legalProblems: string[] = [];
  for (const pt of need) {
    const row = byType.get(pt);
    if (!row) {
      legalProblems.push(`${pt} missing`);
      continue;
    }
    const c = row.content;
    if (typeof c !== "string" || c.trim().length <= LEGAL_MIN_LEN) {
      legalProblems.push(`${pt} missing or too short`);
    }
  }
  if (legalProblems.length) {
    warnings.push(`Missing legal pages: [${legalProblems.join(", ")}]`);
  }

  // CHECK 8 — shop_settings
  if (!settings) {
    hardFailures.push("shop_settings record missing");
  }

  // CHECK 9 — commission
  if (settings) {
    const bearer = settings.commission_bearer;
    const pce = settings.product_commission_enabled;
    const bearerOk = bearer === "shop" || bearer === "customer";
    const pceNum = typeof pce === "number" ? pce : typeof pce === "string" ? parseInt(pce, 10) : NaN;
    const pceOk = pceNum === 0 || pceNum === 1;
    if (!bearerOk || !pceOk) {
      hardFailures.push("Invalid commission settings");
    }
  }

  // CHECK 10 — trust / USPs (WARNING only)
  if (shopSite) {
    const ts = parseJsonArrayField(shopSite.trust_signals_json);
    const us = parseJsonArrayField(shopSite.usps_json);
    const tsOk = ts.ok && ts.arr.length >= 1;
    const usOk = us.ok && us.arr.length >= 1;
    if (!tsOk || !usOk) {
      warnings.push("Missing trust signals or USPs");
    }
  }

  // CHECK 11 — shop payable state
  if (!shop) {
    hardFailures.push("Shop record missing for shopId");
  } else {
    const st = shop.status;
    const stripe = shop.stripe_payment_status;
    const statusOk = st === "pending" || st === "active";
    if (!statusOk) {
      hardFailures.push(`Shop is not in a payable state — status: ${String(st)}`);
    } else if (stripe !== "paid") {
      hardFailures.push(`Shop is not in a payable state — stripe_payment_status: ${String(stripe)}`);
    }
  }

  // CHECK 12 — fonts (WARNING only)
  if (shopSite && (!nonEmptyString(shopSite.font_heading) || !nonEmptyString(shopSite.font_body))) {
    warnings.push("Missing font configuration");
  }

  return { hardFailures, warnings };
}

/** Deferred image prompts from audit when hero/logo URLs are missing. */
function parseImagePromptsFromBuildOutput(buildOutputRaw: string | null): {
  heroImagePrompt: string;
  logoPrompt: string;
  catalogImagePrompts: string[];
} | null {
  if (!buildOutputRaw) return null;
  try {
    const bo = JSON.parse(buildOutputRaw) as Record<string, unknown>;
    const h = bo.heroImagePrompt;
    const l = bo.logoPrompt;
    const c = bo.catalogImagePrompts;
    if (typeof h !== "string" || typeof l !== "string" || !Array.isArray(c)) return null;
    const catalogImagePrompts = c.filter((x): x is string => typeof x === "string");
    return { heroImagePrompt: h, logoPrompt: l, catalogImagePrompts };
  } catch {
    return null;
  }
}

function buildOutputNeedsDeferredImages(buildOutputRaw: string | null): boolean {
  if (!buildOutputRaw) return true;
  try {
    const bo = JSON.parse(buildOutputRaw) as Record<string, unknown>;
    return !nonEmptyString(bo.heroUrl) || !nonEmptyString(bo.logoUrl);
  } catch {
    return true;
  }
}

function parseInput(body: unknown): AuditQueueMessage | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.jobId !== "string" || typeof o.shopId !== "string") return null;
  if (typeof o.shopSlug !== "string" || typeof o.shopName !== "string") return null;
  return { jobId: o.jobId, shopId: o.shopId, shopSlug: o.shopSlug, shopName: o.shopName };
}

async function processOneMessage(body: unknown, env: Env): Promise<void> {
  const input = parseInput(body);
  if (!input) {
    console.error("[pivot-parlor-audit] Invalid audit message", body);
    return;
  }

  const { jobId, shopId, shopSlug, shopName } = input;

  try {
    const shopSite = await env.DB.prepare("SELECT * FROM shop_sites WHERE shop_id = ?").bind(shopId).first<
      Record<string, unknown>
    >();

    const pagesRes = await env.DB.prepare("SELECT * FROM shop_pages WHERE shop_id = ?").bind(shopId).all();
    const pages = d1Rows<Record<string, unknown>>(pagesRes);

    const settings = await env.DB.prepare("SELECT * FROM shop_settings WHERE shop_id = ?").bind(shopId).first<
      Record<string, unknown>
    >();

    const shop = await env.DB.prepare("SELECT * FROM shops WHERE id = ?").bind(shopId).first<Record<string, unknown>>();

    const { hardFailures, warnings } = runQualityChecks(shopSite, pages, settings, shop);

    if (hardFailures.length === 0) {
      await env.DB.prepare("UPDATE shops SET status = ? WHERE id = ?").bind("active", shopId).run();
      await env.DB.prepare("UPDATE shop_sites SET status = ? WHERE shop_id = ?").bind("active", shopId).run();

      const auditPayload = {
        passed: true,
        checks_run: 12,
        hard_failures: 0,
        warnings,
        completed_at: new Date().toISOString(),
      };

      await updateGenerationJob(env.DB, jobId, {
        status: "complete",
        stage: "complete",
        audit_output: JSON.stringify(auditPayload),
        error: null,
      });

      await env.KV.put(
        jobKvKey(jobId),
        JSON.stringify({
          status: "complete",
          stage: "complete",
          shopSlug,
          siteUrl: `https://pivotparlor.com/${shopSlug}`,
        })
      );

      if (shopSite) {
        await env.KV.put(siteKvKey(shopSlug), JSON.stringify(shopSite), { expirationTtl: SITE_CACHE_TTL_SEC });
      }

      const jobRow = await env.DB.prepare("SELECT build_output FROM generation_jobs WHERE id = ?")
        .bind(jobId)
        .first<{ build_output: string | null }>();
      const imagePrompts = parseImagePromptsFromBuildOutput(jobRow?.build_output ?? null);
      const needsDeferred = buildOutputNeedsDeferredImages(jobRow?.build_output ?? null);

      if (!env.site_images_queue) {
        console.warn("[pivot-parlor-audit] site_images_queue binding missing; skipping deferred image generation");
      } else if (!imagePrompts) {
        console.warn(
          "[pivot-parlor-audit] No heroImagePrompt/logoPrompt/catalogImagePrompts on generation_jobs.build_output; skipping deferred image generation"
        );
      } else if (!needsDeferred) {
        console.log(
          `[pivot-parlor-audit] build_output already has heroUrl and logoUrl; skipping site-images-queue enqueue jobId=${jobId}`
        );
      } else {
        await env.site_images_queue.send({
          jobId,
          shopId,
          shopSlug,
          heroImagePrompt: imagePrompts.heroImagePrompt,
          logoPrompt: imagePrompts.logoPrompt,
          catalogImagePrompts: imagePrompts.catalogImagePrompts,
        });
        console.log(`[pivot-parlor-audit] Enqueued site-images-queue for jobId=${jobId} shopSlug=${shopSlug}`);
      }

      console.log(
        `[pivot-parlor-audit] PASS shopName=${shopName} shopSlug=${shopSlug} warnings=${JSON.stringify(warnings)}`
      );
    } else {
      const auditPayload = {
        passed: false,
        checks_run: 12,
        hard_failures: hardFailures.length,
        errors: hardFailures,
        warnings,
        failed_at: new Date().toISOString(),
      };

      await updateGenerationJob(env.DB, jobId, {
        status: "failed",
        audit_output: JSON.stringify(auditPayload),
        error: null,
      });

      await env.KV.put(
        jobKvKey(jobId),
        JSON.stringify({
          status: "failed",
          error: hardFailures.join(", "),
          stage: "audit",
        })
      );

      console.error(
        `[pivot-parlor-audit] FAIL shopName=${shopName} shopSlug=${shopSlug} errors=${JSON.stringify(hardFailures)} warnings=${JSON.stringify(warnings)}`
      );
    }
  } catch (err) {
    const msg = errorMessage(err);
    console.error("[pivot-parlor-audit] Unexpected error", jobId, err);
    try {
      await updateGenerationJob(env.DB, jobId, {
        status: "failed",
        error: msg,
      });
      await env.KV.put(jobKvKey(jobId), JSON.stringify({ status: "failed", error: msg }));
    } catch (persistErr) {
      console.error("[pivot-parlor-audit] Failed to persist unexpected error", persistErr);
    }
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processOneMessage(msg.body, env);
      } catch (err) {
        console.error("[pivot-parlor-audit] Outer failure", err);
      } finally {
        msg.ack();
      }
    }
  },
};
