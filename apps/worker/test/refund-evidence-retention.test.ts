// Refund evidence files are personal data in the private bucket. They go when
// their 6 years are up (the nightly retention sweep), and when the shop they
// belong to is deleted. The request row stays, marked as having had evidence.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RETENTION_POLICY, runRetentionSweep } from "../src/services/retention";
import { dispatch } from "./request";
import { authHeaders, seedShop } from "./helpers";
import { devToken } from "./audit-helpers";

const yearsAgo = (years: number, extraDays = 0) =>
  new Date(Date.now() - (years * 365.25 + extraDays) * 86_400_000).toISOString();

async function seedRequest(
  shopId: string,
  opts: { requestedAt: string; reviewedAt?: string | null; withFile?: boolean },
): Promise<{ id: string; key: string | null }> {
  const id = crypto.randomUUID();
  const key = opts.withFile === false ? null : `refund-evidence/${shopId}/${id}.png`;
  if (key) await env.AUDIT_ARCHIVE.put(key, "png");
  const decided = opts.reviewedAt ?? null;
  await env.DB.prepare(
    `INSERT INTO refund_requests (id, shop_id, kind, sale_id, amount_pence, reason, evidence_key, evidence_name,
       evidence_type, status, requested_by, requested_at, reviewed_by, reviewed_at)
     VALUES (?, ?, 'sale', ?, 500, 'Customer said it was faulty', ?, ?, ?, ?, 'user-x', ?, ?, ?)`,
  )
    .bind(
      id,
      shopId,
      `sale-${id}`,
      key,
      key ? "receipt of Jane Doe.png" : null,
      key ? "image/png" : null,
      decided ? "approved" : "pending",
      opts.requestedAt,
      decided ? "user-y" : null,
      decided,
    )
    .run();
  return { id, key };
}

const row = (id: string) =>
  env.DB.prepare(
    "SELECT evidence_key, evidence_name, evidence_type, evidence_expired_at, status, reason FROM refund_requests WHERE id = ?",
  )
    .bind(id)
    .first<Record<string, string | null>>();

describe("refund evidence retention", () => {
  it("removes a file 6 years after the decision, and keeps the request", async () => {
    const shopId = await seedShop("Evidence Old");
    const years = RETENTION_POLICY.refundEvidenceYears;
    expect(years).toBe(6);
    const old = await seedRequest(shopId, { requestedAt: yearsAgo(years, 40), reviewedAt: yearsAgo(years, 30) });

    const { counts, errors } = await runRetentionSweep(env.DB, env.AUDIT_ARCHIVE);
    expect(errors).toEqual([]);
    expect(counts.refund_evidence_expired).toBeGreaterThanOrEqual(1);

    expect(await env.AUDIT_ARCHIVE.head(old.key!)).toBeNull();
    const after = await row(old.id);
    expect(after).toMatchObject({
      evidence_key: null,
      evidence_name: null,
      evidence_type: null,
      status: "approved",
      reason: "Customer said it was faulty",
    });
    expect(after!.evidence_expired_at).toBeTruthy();

    // Idempotent: nothing left to do for it.
    const stamp = after!.evidence_expired_at;
    await runRetentionSweep(env.DB, env.AUDIT_ARCHIVE);
    expect((await row(old.id))!.evidence_expired_at).toBe(stamp);
  });

  it("keeps files that are younger, counting from the decision and not the filing", async () => {
    const shopId = await seedShop("Evidence Young");
    const years = RETENTION_POLICY.refundEvidenceYears;
    const fresh = await seedRequest(shopId, { requestedAt: yearsAgo(1), reviewedAt: yearsAgo(1) });
    // Filed over 6 years ago, decided inside the window: the clock runs from the decision.
    const lateDecision = await seedRequest(shopId, { requestedAt: yearsAgo(years, 30), reviewedAt: yearsAgo(years - 1) });
    // Never decided: the clock runs from the filing.
    const neverDecided = await seedRequest(shopId, { requestedAt: yearsAgo(years, 30) });
    const noFile = await seedRequest(shopId, { requestedAt: yearsAgo(years, 30), withFile: false });

    const { errors } = await runRetentionSweep(env.DB, env.AUDIT_ARCHIVE);
    expect(errors).toEqual([]);

    expect(await env.AUDIT_ARCHIVE.head(fresh.key!)).not.toBeNull();
    expect((await row(fresh.id))!.evidence_key).toBe(fresh.key);
    expect(await env.AUDIT_ARCHIVE.head(lateDecision.key!)).not.toBeNull();
    expect((await row(lateDecision.id))!.evidence_expired_at).toBeNull();
    expect(await env.AUDIT_ARCHIVE.head(neverDecided.key!)).toBeNull();
    expect((await row(neverDecided.id))!.evidence_expired_at).toBeTruthy();
    // A request that never had a file is not marked as having lost one.
    expect((await row(noFile.id))!.evidence_expired_at).toBeNull();
  });

  it("leaves a file alone while a younger request still points at it", async () => {
    const shopId = await seedShop("Evidence Shared");
    const years = RETENTION_POLICY.refundEvidenceYears;
    const old = await seedRequest(shopId, { requestedAt: yearsAgo(years, 30) });
    const young = await seedRequest(shopId, { requestedAt: yearsAgo(1), withFile: false });
    await env.DB.prepare("UPDATE refund_requests SET evidence_key = ? WHERE id = ?").bind(old.key, young.id).run();

    await runRetentionSweep(env.DB, env.AUDIT_ARCHIVE);
    expect((await row(old.id))!.evidence_key).toBeNull();
    expect((await row(young.id))!.evidence_key).toBe(old.key);
    expect(await env.AUDIT_ARCHIVE.head(old.key!)).not.toBeNull();
  });

  it("is bounded per run", async () => {
    const shopId = await seedShop("Evidence Bounded");
    const years = RETENTION_POLICY.refundEvidenceYears;
    for (let i = 0; i < 3; i++) await seedRequest(shopId, { requestedAt: yearsAgo(years, 30) });
    const { counts } = await runRetentionSweep(env.DB, env.AUDIT_ARCHIVE, 2);
    expect(counts.refund_evidence_expired).toBe(2);
  });
});

describe("deleting a shop", () => {
  it("removes that shop's evidence files and leaves another shop's alone", async () => {
    const gone = await seedShop("Evidence Shop Gone");
    const stays = await seedShop("Evidence Shop Stays");
    const a = await seedRequest(gone, { requestedAt: yearsAgo(1) });
    const b = await seedRequest(gone, { requestedAt: yearsAgo(1), reviewedAt: yearsAgo(1) });
    const other = await seedRequest(stays, { requestedAt: yearsAgo(1) });

    const { token } = await devToken();
    const res = await dispatch("DELETE", `/api/shops/${gone}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);

    expect(await env.AUDIT_ARCHIVE.head(a.key!)).toBeNull();
    expect(await env.AUDIT_ARCHIVE.head(b.key!)).toBeNull();
    expect(await env.AUDIT_ARCHIVE.head(other.key!)).not.toBeNull();
    expect(await row(a.id)).toBeNull();
    expect((await row(other.id))!.evidence_key).toBe(other.key);
  });
});
