/**
 * Owner review for regenerated public sites (migration 049).
 *
 * The assembler stores a live/paused site's regeneration in
 * shop_site_candidates; these routes let a developer or the shop's own admin
 * preview it, publish it or discard it. Payloads are built with the
 * assembler's own buildCandidatePayload, so this suite is also the contract
 * test between the two workers.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { CANDIDATE_COLUMNS, parseCandidatePayload } from "../src/lib/siteCandidate";
import { publishSiteCandidateStatements } from "../src/db/queries";
import { AUDIT_REFUSED_MESSAGE } from "../src/audit/context";
import {
  CANDIDATE_COLUMNS as ASSEMBLER_COLUMNS,
  buildCandidatePayload,
  type CandidateColumnValues,
} from "../../workers/builder/src/publication";

const LIVE_HEADLINE = "The live headline";
const NEW_HEADLINE = "The regenerated headline";

async function slugOf(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT slug FROM shops WHERE id = ?").bind(shopId).first<{ slug: string }>();
  return row!.slug;
}

async function addService(shopId: string, name: string, category = "Cuts") {
  await env.DB.prepare(
    `INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active)
     VALUES (?, ?, ?, 30, 2000, ?, 1)`,
  )
    .bind(crypto.randomUUID(), shopId, name, category)
    .run();
}

async function addLiveSite(shopId: string, opts: { locked?: string; status?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO shop_sites (id, shop_id, template, headline, tagline, services_json, hero_image_url,
       color_primary, website_status, locked_images_json)
     VALUES (?, ?, 'classic', ?, 'Live tagline', ?, 'https://img.test/live-hero.png', '#222222', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      shopId,
      LIVE_HEADLINE,
      JSON.stringify([{ name: "Skin fade", description: "Live copy for the fade." }]),
      opts.status ?? "live",
      opts.locked ?? null,
    )
    .run();
}

function columns(overrides: Partial<CandidateColumnValues> = {}): CandidateColumnValues {
  const base = Object.fromEntries(CANDIDATE_COLUMNS.map((c) => [c, null])) as CandidateColumnValues;
  return {
    ...base,
    headline: NEW_HEADLINE,
    tagline: "New tagline",
    about: "New about.",
    services_json: JSON.stringify([{ name: "Skin fade", description: "New copy for the fade." }]),
    hero_image_url: "https://img.test/new-hero.png",
    catalog_images_json: JSON.stringify(["https://img.test/new-fade.png"]),
    color_primary: "#101010",
    design_version: 3,
    generated_at: "2026-11-06T10:00:00Z",
    ...overrides,
  };
}

async function addCandidate(
  shopId: string,
  jobId: string,
  opts: { serviceNames?: string[]; ownerPalette?: { primary: string; accent: string } | null; payload?: string } = {},
) {
  const payload =
    opts.payload ??
    buildCandidatePayload({
      columns: columns(),
      ownerPalette: opts.ownerPalette ?? null,
      serviceNames: opts.serviceNames ?? ["Skin fade"],
    });
  await env.DB.prepare(
    "INSERT INTO shop_site_candidates (shop_id, job_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(shopId, jobId, payload, "2026-11-06T10:00:00Z")
    .run();
}

async function devToken() {
  return tokenFor(await seedUser("developer", null), "developer", null);
}

async function publicSite(shopId: string) {
  const res = await dispatch("GET", `/api/shops/${shopId}/site`);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

async function candidateCount(shopId: string) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_site_candidates WHERE shop_id = ?")
    .bind(shopId)
    .first<{ n: number }>();
  return r!.n;
}

/** A live shop with one service and a pending version from job-A. */
async function reviewFixture(opts: { locked?: string; ownerPalette?: { primary: string; accent: string } } = {}) {
  const shopId = await seedShop("Review Barber");
  await addService(shopId, "Skin fade");
  await addLiveSite(shopId, { locked: opts.locked });
  await addCandidate(shopId, "job-A", { ownerPalette: opts.ownerPalette ?? null });
  return shopId;
}

describe("assembler ↔ API contract", () => {
  it("both workers allow exactly the same columns", () => {
    expect([...ASSEMBLER_COLUMNS]).toEqual([...CANDIDATE_COLUMNS]);
  });

  it("the API accepts what the assembler stores, and refuses anything else", () => {
    const stored = buildCandidatePayload({ columns: columns(), ownerPalette: { primary: "#111111", accent: "#222222" }, serviceNames: ["A"] });
    expect(parseCandidatePayload(stored)?.columns.headline).toBe(NEW_HEADLINE);

    const bad = JSON.parse(stored) as { columns: Record<string, unknown> };
    bad.columns.owner_color_primary = "#000000";
    expect(parseCandidatePayload(JSON.stringify(bad))).toBeNull();
    expect(parseCandidatePayload(JSON.stringify({ ...JSON.parse(stored), version: 2 }))).toBeNull();
    expect(parseCandidatePayload("not json")).toBeNull();
  });
});

describe("GET /api/shops/:shopId/site-candidate (preview)", () => {
  it("shows the pending version with its own service copy, and leaves the public site alone", async () => {
    const shopId = await reviewFixture();
    const res = await dispatch("GET", `/api/shops/${shopId}/site-candidate`, { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await res.json()) as {
      data: { job_id: string; services_unchanged: boolean; site: Record<string, unknown>; services: Array<{ name: string; description: string }> };
    };
    expect(body.data.job_id).toBe("job-A");
    expect(body.data.services_unchanged).toBe(true);
    expect(body.data.site.headline).toBe(NEW_HEADLINE);
    expect(body.data.site.hero_image_url).toBe("https://img.test/new-hero.png");
    expect(body.data.site.design_version).toBe(3);
    expect(body.data.services).toEqual([expect.objectContaining({ name: "Skin fade", description: "New copy for the fade." })]);

    const live = await publicSite(shopId);
    expect(live.headline).toBe(LIVE_HEADLINE);
  });

  it("previews a locked hero exactly as Publish will keep it", async () => {
    const shopId = await reviewFixture({ locked: JSON.stringify({ hero: true }) });
    const res = await dispatch("GET", `/api/shops/${shopId}/site-candidate`, { headers: authHeaders(await devToken()) });
    const body = (await res.json()) as { data: { site: Record<string, unknown> } };
    expect(body.data.site.hero_image_url).toBe("https://img.test/live-hero.png");
    expect(body.data.site.headline).toBe(NEW_HEADLINE);
  });

  it("404s when nothing is waiting", async () => {
    const shopId = await seedShop("Nothing Pending");
    await addLiveSite(shopId);
    const res = await dispatch("GET", `/api/shops/${shopId}/site-candidate`, { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(404);
  });

  it("refuses a payload it does not understand instead of rendering it", async () => {
    const shopId = await seedShop("Odd Payload");
    await addLiveSite(shopId);
    await addCandidate(shopId, "job-X", { payload: JSON.stringify({ version: 1, columns: { password_hash: "x", headline: "h" } }) });
    const res = await dispatch("GET", `/api/shops/${shopId}/site-candidate`, { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/shops/:shopId/site-candidate/publish", () => {
  it("publishes the previewed version, busts the cached site and clears the candidate", async () => {
    const shopId = await reviewFixture();
    // Warm the public cache with the live copy first: a missed bust would keep
    // serving the old headline.
    expect((await publicSite(shopId)).headline).toBe(LIVE_HEADLINE);
    expect(await env.KV.get(`site:${await slugOf(shopId)}`)).not.toBeNull();

    const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: { job_id: "job-A" },
    });
    expect(res.status).toBe(200);

    const live = await publicSite(shopId);
    expect(live.headline).toBe(NEW_HEADLINE);
    expect(live.tagline).toBe("New tagline");
    expect(live.hero_image_url).toBe("https://img.test/new-hero.png");
    expect(live.website_status).toBe("live");
    expect(await candidateCount(shopId)).toBe(0);

    const services = await dispatch("GET", `/api/shops/${shopId}/services`);
    const list = ((await services.json()) as { data: Array<{ description: string }> }).data;
    expect(list[0]!.description).toBe("New copy for the fade.");
  });

  it("refuses a version that is not the one previewed", async () => {
    const shopId = await reviewFixture();
    const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: { job_id: "job-OLD" },
    });
    expect(res.status).toBe(409);
    expect((await publicSite(shopId)).headline).toBe(LIVE_HEADLINE);
    expect(await candidateCount(shopId)).toBe(1);
  });

  it("requires the job id", async () => {
    const shopId = await reviewFixture();
    const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("refuses when the menu changed, so service photos cannot land on the wrong services", async () => {
    const shopId = await reviewFixture();
    await addService(shopId, "Beard trim");
    const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: { job_id: "job-A" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/services changed/);
    expect((await publicSite(shopId)).headline).toBe(LIVE_HEADLINE);
    expect(await candidateCount(shopId)).toBe(1);
  });

  it("keeps a hero locked after the version was made", async () => {
    const shopId = await reviewFixture({ locked: JSON.stringify({ hero: true }) });
    const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: { job_id: "job-A" },
    });
    expect(res.status).toBe(200);
    const live = await publicSite(shopId);
    expect(live.hero_image_url).toBe("https://img.test/live-hero.png");
    expect(live.headline).toBe(NEW_HEADLINE);
  });

  it("writes nothing when a newer version replaced the checked one mid-publish", async () => {
    const shopId = await reviewFixture({ ownerPalette: { primary: "#123456", accent: "#ABCDEF" } });
    // The route checked job-A; a newer regeneration (job-B) lands before the batch runs.
    await env.DB.prepare("UPDATE shop_site_candidates SET job_id = 'job-B' WHERE shop_id = ?").bind(shopId).run();
    const results = await env.DB.batch(
      publishSiteCandidateStatements(env.DB, {
        shopId,
        jobId: "job-A",
        columns: [["headline", NEW_HEADLINE]],
        ownerPalette: { primary: "#123456", accent: "#ABCDEF" },
      }),
    );
    expect(results.map((r) => r.meta.changes)).toEqual([0, 0, 0]);
    const row = await env.DB.prepare("SELECT headline, owner_color_primary FROM shop_sites WHERE shop_id = ?")
      .bind(shopId)
      .first<{ headline: string; owner_color_primary: string | null }>();
    expect(row).toEqual({ headline: LIVE_HEADLINE, owner_color_primary: null });
    expect(await candidateCount(shopId)).toBe(1);
  });

  it("never writes a column outside the allowed list", () => {
    expect(() =>
      publishSiteCandidateStatements(env.DB, {
        shopId: "s",
        jobId: "j",
        columns: [["owner_email" as never, "x"]],
        ownerPalette: null,
      }),
    ).toThrow(/column not allowed/);
  });

  it("applies the owner's chosen palette with the version", async () => {
    const shopId = await reviewFixture({ ownerPalette: { primary: "#123456", accent: "#ABCDEF" } });
    await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: { job_id: "job-A" },
    });
    const row = await env.DB.prepare("SELECT owner_color_primary, owner_color_accent FROM shop_sites WHERE shop_id = ?")
      .bind(shopId)
      .first<{ owner_color_primary: string; owner_color_accent: string }>();
    expect(row).toEqual({ owner_color_primary: "#123456", owner_color_accent: "#ABCDEF" });
  });
});

describe("DELETE /api/shops/:shopId/site-candidate (discard)", () => {
  it("discards the previewed version and leaves the public site as it was", async () => {
    const shopId = await reviewFixture();
    const wrong = await dispatch("DELETE", `/api/shops/${shopId}/site-candidate?job_id=job-OLD`, { headers: authHeaders(await devToken()) });
    expect(wrong.status).toBe(409);
    expect(await candidateCount(shopId)).toBe(1);

    const res = await dispatch("DELETE", `/api/shops/${shopId}/site-candidate?job_id=job-A`, { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    expect(await candidateCount(shopId)).toBe(0);
    expect((await publicSite(shopId)).headline).toBe(LIVE_HEADLINE);
  });
});

describe("who may review", () => {
  it("lets the shop's own admin preview, publish and discard by shop id", async () => {
    const shopId = await reviewFixture();
    const token = await tokenFor(await seedUser("admin", shopId), "admin", shopId);
    const get = await dispatch("GET", `/api/shops/${shopId}/site-candidate`, { headers: authHeaders(token) });
    expect(get.status).toBe(200);
    const pub = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(token),
      body: { job_id: "job-A" },
    });
    expect(pub.status).toBe(200);
  });

  it("refuses an admin of another shop, staff and customers, and anonymous callers", async () => {
    const shopId = await reviewFixture();
    const otherShop = await seedShop("Other Shop");
    const otherAdmin = await tokenFor(await seedUser("admin", otherShop), "admin", otherShop);
    const staff = await tokenFor(await seedUser("staff", shopId), "staff", shopId);
    const customer = await tokenFor(await seedUser("customer", null), "customer", null);

    for (const token of [otherAdmin, staff, customer]) {
      const get = await dispatch("GET", `/api/shops/${shopId}/site-candidate`, { headers: authHeaders(token) });
      expect(get.status).toBe(403);
      const pub = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
        headers: authHeaders(token),
        body: { job_id: "job-A" },
      });
      expect(pub.status).toBe(403);
      const del = await dispatch("DELETE", `/api/shops/${shopId}/site-candidate?job_id=job-A`, { headers: authHeaders(token) });
      expect(del.status).toBe(403);
    }
    expect((await dispatch("GET", `/api/shops/${shopId}/site-candidate`)).status).toBe(401);
    expect((await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, { body: { job_id: "job-A" } })).status).toBe(401);
    expect((await dispatch("DELETE", `/api/shops/${shopId}/site-candidate?job_id=job-A`)).status).toBe(401);

    expect(await candidateCount(shopId)).toBe(1);
    expect((await publicSite(shopId)).headline).toBe(LIVE_HEADLINE);
  });
});

describe("GET /api/jobs/:jobId/status outcome", () => {
  async function addJob(shopId: string, status: string, stage: string) {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO generation_jobs (id, shop_id, status, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, shopId, status, stage, "2026-11-06T10:00:00Z", "2026-11-06T10:00:00Z")
      .run();
    return id;
  }

  it("says whether a finished job published the site or is waiting for review", async () => {
    const shopId = await seedShop("Outcome Shop");
    const token = await devToken();
    const outcome = async (id: string) =>
      ((await (await dispatch("GET", `/api/jobs/${id}/status`, { headers: authHeaders(token) })).json()) as {
        data: { outcome?: string };
      }).data.outcome;

    expect(await outcome(await addJob(shopId, "complete", "review"))).toBe("candidate");
    expect(await outcome(await addJob(shopId, "complete", "complete"))).toBe("published");
    expect(await outcome(await addJob(shopId, "running", "parallel"))).toBeUndefined();
    expect(await outcome(await addJob(shopId, "failed", "assemble"))).toBeUndefined();
  });
});

describe("site-candidate routes are audited", () => {
  const auditRows = (shopId: string, action: string) =>
    env.DB.prepare("SELECT * FROM audit_log WHERE shop_id = ? AND action = ? ORDER BY occurred_at, phase DESC")
      .bind(shopId, action)
      .all<Record<string, unknown>>()
      .then((r) => r.results ?? []);

  const phasesAndOutcomes = (rows: Array<Record<string, unknown>>) => rows.map((r) => [r.phase, r.outcome]);

  it("publish records started + succeeded with the job id, and no gap entry", async () => {
    const shopId = await reviewFixture();
    const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: { job_id: "job-A" },
    });
    expect(res.status).toBe(200);
    const rows = await auditRows(shopId, "site.candidate.publish");
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "succeeded"]]);
    const outcome = rows.find((r) => r.phase === "outcome")!;
    expect(outcome).toMatchObject({ actor_type: "developer", entity_type: "shop_site", entity_id: shopId });
    expect(JSON.parse(outcome.details_json as string)).toEqual({ job_id: "job-A" });
    const gaps = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap' AND request_id = ?")
      .bind(outcome.request_id)
      .first<{ n: number }>();
    expect(gaps!.n).toBe(0);
  });

  it("publish of a stale version is recorded as refused, and the live site is unchanged", async () => {
    const shopId = await reviewFixture();
    const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(await devToken()),
      body: { job_id: "job-OLD" },
    });
    expect(res.status).toBe(409);
    const rows = await auditRows(shopId, "site.candidate.publish");
    expect(phasesAndOutcomes(rows)).toEqual([["started", null], ["outcome", "refused"]]);
    expect(rows.find((r) => r.phase === "outcome")!.reason).toBe("HTTP 409");
    expect((await publicSite(shopId)).headline).toBe(LIVE_HEADLINE);
  });

  it("publish changes nothing (503) when the audit entry cannot be written", async () => {
    const shopId = await reviewFixture();
    const token = await devToken();
    await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
    try {
      const res = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
        headers: authHeaders(token),
        body: { job_id: "job-A" },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    } finally {
      await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
    }
    expect(await candidateCount(shopId)).toBe(1);
    expect((await publicSite(shopId)).headline).toBe(LIVE_HEADLINE);
  });

  it("never writes a malformed job id into the trail", async () => {
    const shopId = await reviewFixture();
    const token = await devToken();
    const bad = "<script>job</script>";
    const publish = await dispatch("POST", `/api/shops/${shopId}/site-candidate/publish`, {
      headers: authHeaders(token),
      body: { job_id: bad },
    });
    expect(publish.status).toBe(400);
    const discard = await dispatch("DELETE", `/api/shops/${shopId}/site-candidate?job_id=${encodeURIComponent(bad)}`, {
      headers: authHeaders(token),
    });
    expect(discard.status).toBe(400);
    const leaked = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE details_json LIKE ?")
      .bind("%<script>%")
      .first<{ n: number }>();
    expect(leaked!.n).toBe(0);
    expect(await candidateCount(shopId)).toBe(1);
  });

  it("discard records succeeded, and a stale discard is refused and keeps the candidate", async () => {
    const shopId = await reviewFixture();
    const token = await devToken();
    const stale = await dispatch("DELETE", `/api/shops/${shopId}/site-candidate?job_id=job-OLD`, {
      headers: authHeaders(token),
    });
    expect(stale.status).toBe(409);
    expect(await candidateCount(shopId)).toBe(1);

    const ok = await dispatch("DELETE", `/api/shops/${shopId}/site-candidate?job_id=job-A`, {
      headers: authHeaders(token),
    });
    expect(ok.status).toBe(200);
    expect(await candidateCount(shopId)).toBe(0);

    const rows = await auditRows(shopId, "site.candidate.discard");
    const outcomes = rows.filter((r) => r.phase === "outcome").map((r) => [r.outcome, r.reason]);
    expect(outcomes).toEqual([["refused", "HTTP 409"], ["succeeded", null]]);
    expect(rows.filter((r) => r.phase === "started")).toHaveLength(2);
  });
});
