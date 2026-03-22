import { Hono } from "hono";
import type { Bindings } from "../bindings.js";
import { authMiddleware, getUser } from "../middleware/auth.js";
import { getGenerationJobById, getShopById } from "../db/queries.js";

const jobs = new Hono<{ Bindings: Bindings }>();

/** GET /api/jobs/:jobId/status — auth required; developer or shop admin for that job's shop */
jobs.get("/:jobId/status", authMiddleware, async (c) => {
  const user = getUser(c);
  const jobId = c.req.param("jobId");
  if (!jobId) {
    return c.json({ success: false, error: "Missing job id" }, 400);
  }

  const job = await getGenerationJobById(c.env.DB, jobId);
  if (!job) {
    return c.json({ success: false, error: "Job not found" }, 404);
  }

  const allowed =
    user.role === "developer" || (user.role === "admin" && user.shop_id === job.shop_id);
  if (!allowed) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const shop = await getShopById(c.env.DB, job.shop_id);
  let status = job.status;
  let stage = job.stage;
  let error: string | undefined = job.error ?? undefined;
  let shopSlug = shop?.slug;

  const kvRaw = await c.env.KV.get(`job:${jobId}`);
  if (kvRaw) {
    try {
      const parsed = JSON.parse(kvRaw) as {
        status?: string;
        stage?: string;
        shopSlug?: string;
        error?: string | null;
      };
      if (parsed.status) status = parsed.status;
      if (parsed.stage) stage = parsed.stage;
      if (parsed.shopSlug) shopSlug = parsed.shopSlug;
      if (parsed.error !== undefined && parsed.error !== null) error = String(parsed.error);
    } catch {
      /* keep D1 values */
    }
  }

  return c.json({
    success: true,
    data: { status, stage, shopSlug, error },
  });
});

export default jobs;
