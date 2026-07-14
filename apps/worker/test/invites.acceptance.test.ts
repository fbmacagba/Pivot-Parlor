import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";

/**
 * Article 28 posture (migration 043): accepting an invite must record an
 * auditable legal_acceptances row, and onboarding must be refused unless the
 * Terms + DPA are accepted. Account creation and the acceptance record are
 * written in one db.batch() so an onboarded account can never lack its record.
 */

const FUTURE = "2999-12-31T23:59:59Z";

async function seedInvite(
  shopId: string,
  email: string,
  role: "admin" | "staff",
): Promise<string> {
  const token = `tok${crypto.randomUUID().replace(/-/g, "")}${crypto
    .randomUUID()
    .replace(/-/g, "")}`;
  await env.DB.prepare(
    `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  )
    .bind(`invite-${crypto.randomUUID()}`, email, shopId, role, token, FUTURE)
    .run();
  return token;
}

describe("invite acceptance records a legal acceptance (Article 28)", () => {
  it("admin accept with accept_terms creates the account AND a terms_dpa record", async () => {
    const shopId = await seedShop("Acceptance Admin Shop");
    const email = `admin-${crypto.randomUUID()}@test.local`;
    const token = await seedInvite(shopId, email, "admin");

    const res = await dispatch("POST", `/api/invites/${token}/accept`, {
      body: {
        name: "Ada Owner",
        password: "correct-horse-staple",
        accept_terms: true,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      data: { role: string; shop_id: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.role).toBe("admin");

    const user = await env.DB.prepare(
      "SELECT id FROM platform_users WHERE email = ?",
    )
      .bind(email)
      .first<{ id: string }>();
    expect(user?.id).toBeTruthy();

    const acc = await env.DB.prepare(
      "SELECT document, version, shop_id FROM legal_acceptances WHERE user_id = ?",
    )
      .bind(user!.id)
      .first<{ document: string; version: string; shop_id: string }>();
    expect(acc).toBeTruthy();
    expect(acc!.document).toBe("terms_dpa");
    expect(acc!.version).toBe("1.0");
    expect(acc!.shop_id).toBe(shopId);
  });

  it("refuses acceptance without accept_terms and writes nothing (atomic)", async () => {
    const shopId = await seedShop("Acceptance Reject Shop");
    const email = `noconsent-${crypto.randomUUID()}@test.local`;
    const token = await seedInvite(shopId, email, "admin");

    const res = await dispatch("POST", `/api/invites/${token}/accept`, {
      body: { name: "No Consent", password: "correct-horse-staple" },
    });
    expect(res.status).toBe(400);

    // No user, no acceptance, and the invite is still usable for a real retry.
    const user = await env.DB.prepare(
      "SELECT id FROM platform_users WHERE email = ?",
    )
      .bind(email)
      .first();
    expect(user).toBeNull();

    const acc = await env.DB.prepare(
      "SELECT id FROM legal_acceptances WHERE shop_id = ?",
    )
      .bind(shopId)
      .first();
    expect(acc).toBeNull();

    const invite = await env.DB.prepare(
      "SELECT used_at FROM invites WHERE token = ?",
    )
      .bind(token)
      .first<{ used_at: string | null }>();
    expect(invite?.used_at).toBeNull();
  });

  it("staff invitee records a plain terms acceptance, not terms_dpa", async () => {
    const shopId = await seedShop("Acceptance Staff Shop");
    const email = `staff-${crypto.randomUUID()}@test.local`;
    const token = await seedInvite(shopId, email, "staff");

    const res = await dispatch("POST", `/api/invites/${token}/accept`, {
      body: {
        name: "Stan Staff",
        password: "correct-horse-staple",
        accept_terms: true,
      },
    });
    expect(res.status).toBe(201);

    const user = await env.DB.prepare(
      "SELECT id FROM platform_users WHERE email = ?",
    )
      .bind(email)
      .first<{ id: string }>();
    const acc = await env.DB.prepare(
      "SELECT document FROM legal_acceptances WHERE user_id = ?",
    )
      .bind(user!.id)
      .first<{ document: string }>();
    expect(acc?.document).toBe("terms");
  });
});
