/**
 * /api/jobs/:jobId/status merges D1 (source of truth) with the KV progress
 * cache. KV reads are eventually consistent, so a stale KV "queued" must
 * never drag a job that D1 says is failed/complete back to in-progress —
 * that exact staleness kept the dev progress UI spinning for minutes on a
 * job that failed 14 seconds in.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

async function seedJob(shopId: string, status: string, stage: string, error: string | null) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO generation_jobs (id, shop_id, status, stage, error) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, shopId, status, stage, error)
    .run();
  return id;
}

async function devToken(): Promise<string> {
  const userId = await seedUser("developer", null);
  return tokenFor(userId, "developer", null);
}

type StatusBody = { success: boolean; data: { status: string; stage: string; error?: string } };

describe("job status D1/KV merge", () => {
  it("stale KV 'queued' cannot override a failed job in D1", async () => {
    const shopId = await seedShop("Stale KV Shop");
    const jobId = await seedJob(shopId, "failed", "research", "OpenRouter error 429");
    // Simulate the eventually-consistent read: KV still holds the enqueue-time value.
    await env.KV.put(`job:${jobId}`, JSON.stringify({ status: "queued", stage: "research" }));

    const res = await dispatch("GET", `/api/jobs/${jobId}/status`, {
      headers: authHeaders(await devToken()),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toContain("429");
  });

  it("KV still advances a non-terminal D1 job", async () => {
    const shopId = await seedShop("KV Advance Shop");
    const jobId = await seedJob(shopId, "running", "research", null);
    await env.KV.put(`job:${jobId}`, JSON.stringify({ status: "running", stage: "parallel" }));

    const res = await dispatch("GET", `/api/jobs/${jobId}/status`, {
      headers: authHeaders(await devToken()),
    });

    const body = (await res.json()) as StatusBody;
    expect(body.data.status).toBe("running");
    expect(body.data.stage).toBe("parallel");
  });

  it("a terminal KV state may override a lagging D1 row", async () => {
    const shopId = await seedShop("KV Terminal Shop");
    const jobId = await seedJob(shopId, "running", "assemble", null);
    await env.KV.put(`job:${jobId}`, JSON.stringify({ status: "complete", stage: "complete" }));

    const res = await dispatch("GET", `/api/jobs/${jobId}/status`, {
      headers: authHeaders(await devToken()),
    });

    const body = (await res.json()) as StatusBody;
    expect(body.data.status).toBe("complete");
  });
});
