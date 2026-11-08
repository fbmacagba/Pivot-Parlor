/** Audit trail Plan 2, Task 8: sign-in, accounts, invites, enquiries and the
 *  Stripe webhook record their entry, and no secret or personal value (a
 *  password or its hash, a session, verification or invite token, an email,
 *  name, phone, enquiry text, or a Stripe session id) reaches any audit column.
 *
 *  Every credential is generated at runtime (aramid scans test literals). */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditRecorder } from "@repo/audit";
import { AUDIT_REFUSED_MESSAGE } from "../src/audit/context";
import { hashPassword } from "../src/lib/password";
import { handleCheckoutSessionCompleted } from "../src/routes/webhooks";
import { dispatch } from "./request";
import { authHeaders, seedShop, seedUser, tokenFor } from "./helpers";
import { devToken, entriesFor, expectNoPersonalData, gapRowsFor, withAuditOff } from "./audit-helpers";

const testEnv = env as unknown as Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
  delete testEnv.RESEND_API_KEY;
});

// One IP per request: the routes' rate limits key on it, and an anonymous
// entry's ip_ref must be minted from a real address.
let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq}`;
const secret = (label: string) => `${label}-${crypto.randomUUID()}`;

function rid(res: Response): string {
  return res.headers.get("X-Request-Id") ?? "";
}

/** Every audit_log row one request wrote, oldest first. */
async function rowsForRequest(requestId: string, action?: string): Promise<Record<string, unknown>[]> {
  expect(requestId, "a request id is needed (X-Request-Id)").toMatch(/.+/);
  const sql = action
    ? "SELECT * FROM audit_log WHERE request_id = ? AND action = ? ORDER BY rowid"
    : "SELECT * FROM audit_log WHERE request_id = ? ORDER BY rowid";
  const stmt = action ? env.DB.prepare(sql).bind(requestId, action) : env.DB.prepare(sql).bind(requestId);
  return (await stmt.all<Record<string, unknown>>()).results ?? [];
}

/** No row carries any of `values`, and the subject refs are refs, not values. */
function expectClean(rows: Record<string, unknown>[], values: string[]): void {
  expect(rows.length, "expectClean needs at least one row").toBeGreaterThan(0);
  for (const row of rows) {
    expectNoPersonalData(row, values);
    if (row.actor_ref !== null) expect(String(row.actor_ref)).toMatch(/^subj_user_[A-Za-z0-9-]+$/);
    if (row.ip_ref !== null) expect(String(row.ip_ref)).toMatch(/^subj_ip_[0-9a-f-]{36}$/);
    for (const v of values) {
      const needle = v.trim().toLowerCase();
      if (needle === "") continue;
      for (const col of ["actor_ref", "ip_ref", "shop_id", "actor_role"]) {
        if (row[col] === null) continue;
        expect(String(row[col]).toLowerCase().includes(needle), `${col} carries a submitted value`).toBe(false);
      }
    }
  }
}

/** The personal values a seeded shop row carries (Ruling 17: name and slug count). */
async function shopValues(shopId: string): Promise<string[]> {
  const s = await env.DB.prepare("SELECT name, slug, owner_email FROM shops WHERE id = ?")
    .bind(shopId)
    .first<{ name: string; slug: string; owner_email: string }>();
  expect(s, `no shop ${shopId}`).not.toBeNull();
  return [s!.name, s!.slug, s!.owner_email];
}

/** The personal and secret values a stored account carries: name, email and
 *  its password hash (the seed helper's 1-character placeholder hash is
 *  skipped, since it would match any row containing that letter). */
async function userValues(userId: string): Promise<string[]> {
  const u = await env.DB.prepare("SELECT name, email, password_hash FROM platform_users WHERE id = ?")
    .bind(userId)
    .first<{ name: string | null; email: string; password_hash: string }>();
  expect(u, `no user ${userId}`).not.toBeNull();
  return [u!.name ?? "", u!.email, u!.password_hash.length > 8 ? u!.password_hash : ""];
}

/** Stub the email service's outbound Resend call for one test (restored by
 *  afterEach's vi.restoreAllMocks); any other outbound fetch fails the test. */
function stubResend(): { key: string; sent: string[] } {
  const key = secret("resend");
  testEnv.RESEND_API_KEY = key;
  const sent: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.resend.com")) throw new Error(`unexpected outbound fetch ${url}`);
    sent.push(String(init?.body ?? ""));
    return Response.json({ id: "email-id" });
  });
  return { key, sent };
}

async function seedLoginUser(role: "customer" | "admin" = "customer", shopId: string | null = null) {
  const id = `user-login-${crypto.randomUUID()}`;
  const email = `login-${crypto.randomUUID()}@sign-in.test`;
  const name = `Signin Person ${crypto.randomUUID().slice(0, 8)}`;
  const password = secret("pw");
  const hash = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO platform_users (id, name, email, password_hash, role, shop_id, email_verified) VALUES (?, ?, ?, ?, ?, ?, 1)",
  )
    .bind(id, name, email, hash, role, shopId)
    .run();
  return { id, email, name, password, hash };
}

/** The everify:<token> key minted for one user, if any. */
async function verifyTokenFor(userId: string): Promise<string | null> {
  const list = await env.KV.list({ prefix: "everify:" });
  for (const k of list.keys) {
    const raw = await env.KV.get(k.name);
    if (raw && (JSON.parse(raw) as { user_id?: string }).user_id === userId) return k.name.slice("everify:".length);
  }
  return null;
}

/** Any live session:<jwt> key for one user. */
async function sessionCountFor(userId: string): Promise<number> {
  const list = await env.KV.list({ prefix: "session:" });
  let n = 0;
  for (const k of list.keys) {
    const raw = await env.KV.get(k.name);
    if (raw && (JSON.parse(raw) as { user_id?: string }).user_id === userId) n++;
  }
  return n;
}

// ─── Sign-in ─────────────────────────────────────────────────────────────────

describe("login", () => {
  it("login records the user as actor, never the token", async () => {
    const shopId = await seedShop("Login Audit Shop");
    const user = await seedLoginUser("admin", shopId);
    const res = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { email: user.email, password: user.password },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: { token: string } };
    expect(body).toEqual({ success: true, data: { token: expect.any(String), role: "admin", shop_id: shopId } });
    const token = body.data.token;
    expect(await env.KV.get(`session:${token}`)).not.toBeNull();

    const rows = await rowsForRequest(rid(res), "auth.login");
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows[1]!;
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.parent_id).toBe(rows[0]!.id);
    expect(outcome.entity_type).toBe("platform_user");
    expect(outcome.entity_id).toBe(user.id);
    expect(outcome.actor_type).toBe("admin");
    expect(outcome.actor_ref).toBe(`subj_user_${user.id}`);
    expect(outcome.via).toBe("api");
    expect(outcome.changes_json).toBeNull();
    expect(outcome.details_json).toBeNull();
    expectClean(await rowsForRequest(rid(res)), [token, user.email, user.password, user.hash, user.name, ...(await shopValues(shopId))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a wrong password records a refused login for that account", async () => {
    const user = await seedLoginUser();
    const wrong = secret("wrong");
    const res = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { email: user.email, password: wrong },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "Invalid credentials" });

    const rows = await rowsForRequest(rid(res));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("auth.login");
    expect(row.phase).toBe("done");
    expect(row.outcome).toBe("refused");
    expect(row.reason).toBe("invalid_credentials");
    expect(row.entity_type).toBe("platform_user");
    expect(row.entity_id).toBe(user.id);
    expect(row.actor_type).toBe("anonymous");
    expect(row.actor_ref).toBeNull();
    expect(row.ip_ref).not.toBeNull();
    expectClean(rows, [user.email, wrong, user.password, user.hash, user.name]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("an unknown email records a refused login with no entity and no email", async () => {
    const email = `nobody-${crypto.randomUUID()}@sign-in.test`;
    const password = secret("pw");
    const res = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { email, password },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "Invalid credentials" });

    const rows = await rowsForRequest(rid(res));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("auth.login");
    expect(row.outcome).toBe("refused");
    expect(row.reason).toBe("invalid_credentials");
    expect(row.entity_type).toBeNull();
    expect(row.entity_id).toBeNull();
    expect(row.actor_type).toBe("anonymous");
    expectClean(rows, [email, password]);
    // The submitted email reaches no audit table at all (spec 3.1).
    const subj = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_subjects WHERE email = ?").bind(email).first<{ n: number }>();
    expect(subj!.n).toBe(0);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a login refusal that cannot be recorded still answers 401", async () => {
    const user = await seedLoginUser();
    const res = await withAuditOff(() =>
      dispatch("POST", "/auth/login", {
        headers: { "CF-Connecting-IP": nextIp() },
        body: { email: user.email, password: secret("wrong") },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "Invalid credentials" });
  });

  it("a login with missing fields writes nothing", async () => {
    const res = await dispatch("POST", "/auth/login", {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { email: `half-${crypto.randomUUID()}@sign-in.test` },
    });
    expect(res.status).toBe(400);
    expect(await rowsForRequest(rid(res))).toHaveLength(0);
  });

  it("a login that cannot be recorded issues no session", async () => {
    const user = await seedLoginUser();
    const res = await withAuditOff(() =>
      dispatch("POST", "/auth/login", {
        headers: { "CF-Connecting-IP": nextIp() },
        body: { email: user.email, password: user.password },
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    expect(await sessionCountFor(user.id)).toBe(0);
  });
});

describe("logout", () => {
  it("logout records the session user", async () => {
    const shopId = await seedShop("Logout Audit Shop");
    const userId = await seedUser("admin", shopId);
    const token = await tokenFor(userId, "admin", shopId);
    const res = await dispatch("POST", "/auth/logout", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await env.KV.get(`session:${token}`)).toBeNull();

    const rows = await rowsForRequest(rid(res), "auth.logout");
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows[1]!;
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.entity_type).toBe("platform_user");
    expect(outcome.entity_id).toBe(userId);
    expect(outcome.actor_type).toBe("admin");
    expect(outcome.actor_ref).toBe(`subj_user_${userId}`);
    expect(outcome.changes_json).toBeNull();
    expect(outcome.details_json).toBeNull();
    expectClean(await rowsForRequest(rid(res)), [token, ...(await userValues(userId)), ...(await shopValues(shopId))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("logout without a session writes nothing", async () => {
    // authMiddleware answers 401 before the handler, so there is no
    // session-less 2xx to record (Ruling 4) and a 4xx writes nothing.
    const res = await dispatch("POST", "/auth/logout", { headers: { "CF-Connecting-IP": nextIp() } });
    expect(res.status).toBe(401);
    expect(await rowsForRequest(rid(res))).toHaveLength(0);
  });

  it("logout keeps the session when the entry cannot be written", async () => {
    const userId = await seedUser("customer", null);
    const token = await tokenFor(userId, "customer", null);
    const res = await withAuditOff(() => dispatch("POST", "/auth/logout", { headers: authHeaders(token) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    expect(await env.KV.get(`session:${token}`)).not.toBeNull();
  });
});

// ─── Accounts ────────────────────────────────────────────────────────────────

describe("register", () => {
  it("public register records a customer account, no name or email", async () => {
    const name = `Regina Newcomer ${crypto.randomUUID().slice(0, 6)}`;
    const email = `reg-${crypto.randomUUID()}@sign-up.test`;
    const password = secret("pw");
    const res = await dispatch("POST", "/auth/register", {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { name, email, password },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const id = body.data.id;
    expect(body).toEqual({
      success: true,
      data: { id, name, email, role: "customer", verification_email_sent: false },
    });

    const created = await rowsForRequest(rid(res), "account.create");
    expect(created).toHaveLength(1);
    const row = created[0]!;
    expect(row.phase).toBe("done");
    expect(row.outcome).toBe("succeeded");
    expect(row.entity_type).toBe("platform_user");
    expect(row.entity_id).toBe(id);
    expect(row.shop_id).toBeNull();
    expect(row.actor_type).toBe("anonymous");
    expect(row.actor_ref).toBeNull();
    expect(row.ip_ref).not.toBeNull();
    expect(JSON.parse(row.changes_json as string)).toEqual({ role: [null, "customer"], email_verified: [null, 0] });

    // The verification email is a T step: no mail transport in tests, so it
    // ends failed with a structured reason; the token is minted and never logged.
    const sends = await rowsForRequest(rid(res), "account.verification.send");
    expect(sends.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(sends[1]!.outcome).toBe("failed");
    expect(sends[1]!.reason).toBe("not_configured");
    expect(sends[1]!.entity_type).toBe("platform_user");
    expect(sends[1]!.entity_id).toBe(id);
    const verifyToken = await verifyTokenFor(id);
    expect(verifyToken).not.toBeNull();

    const passwordHash = (await env.DB.prepare("SELECT password_hash FROM platform_users WHERE id = ?").bind(id).first<{ password_hash: string }>())!
      .password_hash;
    expectClean(await rowsForRequest(rid(res)), [name, email, password, passwordHash, verifyToken!]);
    const subj = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_subjects WHERE email = ?").bind(email).first<{ n: number }>();
    expect(subj!.n).toBe(0);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("register leaves no user when the entry cannot be written", async () => {
    const email = `reg-off-${crypto.randomUUID()}@sign-up.test`;
    const res = await withAuditOff(() =>
      dispatch("POST", "/auth/register", {
        headers: { "CF-Connecting-IP": nextIp() },
        body: { name: "Nobody Stored", email, password: secret("pw") },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = ?").bind(email).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("an unrecordable verification step leaves the account and reports no email sent", async () => {
    // Only the T step's started entry is blocked: the account and its entry
    // commit, the token is never minted, and the response is today's 201.
    await env.DB.prepare(
      `CREATE TRIGGER test_block_verification_send BEFORE INSERT ON audit_log
       WHEN NEW.action = 'account.verification.send'
       BEGIN SELECT RAISE(ABORT, 'blocked by test'); END`,
    ).run();
    const form = { name: "Half Recorded", email: `reg-half-${crypto.randomUUID()}@sign-up.test`, password: secret("pw") };
    let res: Response;
    try {
      res = await dispatch("POST", "/auth/register", { headers: { "CF-Connecting-IP": nextIp() }, body: form });
    } finally {
      await env.DB.prepare("DROP TRIGGER test_block_verification_send").run();
    }
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { data: { id: string; verification_email_sent: boolean } };
    expect(body.data.verification_email_sent).toBe(false);
    const user = await env.DB.prepare("SELECT role FROM platform_users WHERE id = ?").bind(body.data.id).first<{ role: string }>();
    expect(user?.role).toBe("customer");
    expect(await verifyTokenFor(body.data.id)).toBeNull();
    expect(await rowsForRequest(rid(res), "account.create")).toHaveLength(1);
    expect(await rowsForRequest(rid(res), "account.verification.send")).toHaveLength(0);
    expectClean(await rowsForRequest(rid(res)), [form.name, form.email, form.password, ...(await userValues(body.data.id))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a developer register records the developer as actor and no raw shop id", async () => {
    const dev = await devToken();
    const shopId = await seedShop("Provisioned Shop");
    const name = `Owner Provisioned ${crypto.randomUUID().slice(0, 6)}`;
    const email = `prov-${crypto.randomUUID()}@sign-up.test`;
    const password = secret("pw");
    const res = await dispatch("POST", "/auth/register", {
      headers: { ...authHeaders(dev.token), "CF-Connecting-IP": nextIp() },
      body: { name, email, password, role: "admin", shop_id: shopId },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body).toEqual({
      success: true,
      data: { id: body.data.id, name, email, role: "admin", verification_email_sent: false },
    });

    const rows = await rowsForRequest(rid(res), "account.create");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("succeeded");
    expect(rows[0]!.entity_id).toBe(body.data.id);
    expect(rows[0]!.actor_type).toBe("developer");
    expect(rows[0]!.actor_ref).toBe(`subj_user_${dev.id}`);
    expect(rows[0]!.shop_id).toBeNull();
    expect(JSON.parse(rows[0]!.changes_json as string)).toEqual({ role: [null, "admin"], email_verified: [null, 1] });
    // Operator-provisioned accounts are born verified: no verification step.
    expect(await rowsForRequest(rid(res), "account.verification.send")).toHaveLength(0);
    expectClean(await rowsForRequest(rid(res)), [
      name,
      email,
      password,
      dev.token,
      ...(await userValues(body.data.id)),
      ...(await userValues(dev.id)),
      ...(await shopValues(shopId)),
    ]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("register with a working mail transport records the verification send as succeeded", async () => {
    const resend = stubResend();
    const name = `Sent Newcomer ${crypto.randomUUID().slice(0, 6)}`;
    const email = `reg-sent-${crypto.randomUUID()}@sign-up.test`;
    const password = secret("pw");
    const res = await dispatch("POST", "/auth/register", {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { name, email, password },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const id = body.data.id;
    expect(body).toEqual({
      success: true,
      data: { id, name, email, role: "customer", verification_email_sent: true },
    });
    expect(resend.sent).toHaveLength(1);

    const created = await rowsForRequest(rid(res), "account.create");
    expect(created).toHaveLength(1);
    expect(created[0]!.phase).toBe("done");
    expect(created[0]!.outcome).toBe("succeeded");

    const sends = await rowsForRequest(rid(res), "account.verification.send");
    expect(sends.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(sends[1]!.outcome).toBe("succeeded");
    expect(sends[1]!.reason).toBeNull();
    expect(sends[1]!.parent_id).toBe(sends[0]!.id);
    expect(sends[1]!.entity_type).toBe("platform_user");
    expect(sends[1]!.entity_id).toBe(id);
    expect(sends[1]!.actor_type).toBe("anonymous");
    expect(sends[1]!.changes_json).toBeNull();
    expect(sends[1]!.details_json).toBeNull();
    const verifyToken = await verifyTokenFor(id);
    expect(verifyToken).not.toBeNull();
    // The link that went out carries the token; no audit row does.
    expect(resend.sent[0]).toContain(verifyToken!);

    expectClean(await rowsForRequest(rid(res)), [name, email, password, verifyToken!, resend.key, ...(await userValues(id))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });
});

describe("verify-email", () => {
  async function mintVerifyToken(userId: string): Promise<string> {
    const token = crypto.randomUUID();
    await env.KV.put(`everify:${token}`, JSON.stringify({ user_id: userId }), { expirationTtl: 3600 });
    return token;
  }

  it("verify-email records email_verified 0 to 1", async () => {
    const userId = await seedUser("customer", null);
    const token = await mintVerifyToken(userId);
    const res = await dispatch("POST", "/auth/verify-email", { headers: { "CF-Connecting-IP": nextIp() }, body: { token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const rows = await rowsForRequest(rid(res), "account.verify_email");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.phase).toBe("done");
    expect(row.outcome).toBe("succeeded");
    expect(row.entity_type).toBe("platform_user");
    expect(row.entity_id).toBe(userId);
    expect(row.actor_type).toBe("anonymous");
    expect(JSON.parse(row.changes_json as string)).toEqual({ email_verified: [0, 1] });
    expect(row.details_json).toBeNull();
    const user = await env.DB.prepare("SELECT email_verified FROM platform_users WHERE id = ?").bind(userId).first<{ email_verified: number }>();
    expect(user?.email_verified).toBe(1);
    expect(await env.KV.get(`everify:${token}`)).toBeNull();
    expectClean(await rowsForRequest(rid(res)), [token, ...(await userValues(userId))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("verify-email on an already verified account records no false change", async () => {
    const userId = await seedUser("customer", null);
    await env.DB.prepare("UPDATE platform_users SET email_verified = 1 WHERE id = ?").bind(userId).run();
    const token = await mintVerifyToken(userId);
    const res = await dispatch("POST", "/auth/verify-email", { headers: { "CF-Connecting-IP": nextIp() }, body: { token } });
    expect(res.status).toBe(200);
    const rows = await rowsForRequest(rid(res), "account.verify_email");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("succeeded");
    expect(rows[0]!.changes_json).toBeNull();
    expectClean(await rowsForRequest(rid(res)), [token, ...(await userValues(userId))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("verify-email for a deleted account records a refusal and answers as before", async () => {
    const token = await mintVerifyToken(`gone-${crypto.randomUUID()}`);
    const res = await dispatch("POST", "/auth/verify-email", { headers: { "CF-Connecting-IP": nextIp() }, body: { token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const rows = await rowsForRequest(rid(res));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("account.verify_email");
    expect(rows[0]!.outcome).toBe("refused");
    expect(rows[0]!.reason).toBe("user_not_found");
    expect(rows[0]!.changes_json).toBeNull();
    expect(await env.KV.get(`everify:${token}`)).toBeNull();
    expectClean(rows, [token]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("verify-email leaves the account unverified when the entry cannot be written", async () => {
    const userId = await seedUser("customer", null);
    const token = await mintVerifyToken(userId);
    const res = await withAuditOff(() =>
      dispatch("POST", "/auth/verify-email", { headers: { "CF-Connecting-IP": nextIp() }, body: { token } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const user = await env.DB.prepare("SELECT email_verified FROM platform_users WHERE id = ?").bind(userId).first<{ email_verified: number }>();
    expect(user?.email_verified).toBe(0);
    expect(await env.KV.get(`everify:${token}`)).not.toBeNull();
  });

  it("verify-email with an unknown token writes nothing", async () => {
    const res = await dispatch("POST", "/auth/verify-email", {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { token: crypto.randomUUID() },
    });
    expect(res.status).toBe(400);
    expect(await rowsForRequest(rid(res))).toHaveLength(0);
  });
});

describe("resend-verification", () => {
  it("resend-verification records the session user, never the token", async () => {
    const userId = await seedUser("customer", null);
    const session = await tokenFor(userId, "customer", null);
    const resend = stubResend();
    const res = await dispatch("POST", "/auth/resend-verification", { headers: authHeaders(session) });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(resend.sent).toHaveLength(1);

    const rows = await rowsForRequest(rid(res), "account.verification.send");
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = rows[1]!;
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.reason).toBeNull();
    expect(outcome.entity_type).toBe("platform_user");
    expect(outcome.entity_id).toBe(userId);
    expect(outcome.actor_type).toBe("customer");
    expect(outcome.actor_ref).toBe(`subj_user_${userId}`);
    const verifyToken = await verifyTokenFor(userId);
    expect(verifyToken).not.toBeNull();
    expectClean(await rowsForRequest(rid(res)), [session, verifyToken!, resend.key, ...(await userValues(userId))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("a resend with no mail transport records a failed send", async () => {
    const userId = await seedUser("customer", null);
    const session = await tokenFor(userId, "customer", null);
    const res = await dispatch("POST", "/auth/resend-verification", { headers: authHeaders(session) });
    expect(res.status).toBe(502);
    const rows = await rowsForRequest(rid(res), "account.verification.send");
    expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    expect(rows[1]!.outcome).toBe("failed");
    expect(rows[1]!.reason).toBe("not_configured");
    const verifyToken = await verifyTokenFor(userId);
    expect(verifyToken).not.toBeNull();
    expectClean(await rowsForRequest(rid(res)), [session, verifyToken!, ...(await userValues(userId))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("resend-verification mints no token when the entry cannot be written", async () => {
    const userId = await seedUser("customer", null);
    const session = await tokenFor(userId, "customer", null);
    const res = await withAuditOff(() => dispatch("POST", "/auth/resend-verification", { headers: authHeaders(session) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
    expect(await verifyTokenFor(userId)).toBeNull();
  });
});

// ─── Invites ─────────────────────────────────────────────────────────────────

describe("invite accept", () => {
  async function seedInvite(shopId: string, role: "admin" | "staff") {
    const id = `invite-${crypto.randomUUID()}`;
    const email = `invitee-${crypto.randomUUID()}@onboard.test`;
    const token = `tok${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    await env.DB.prepare(
      `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active) VALUES (?, ?, ?, ?, ?, '2999-12-31T23:59:59Z', 1)`,
    )
      .bind(id, email, shopId, role, token)
      .run();
    return { id, email, token };
  }

  async function shopState(shopId: string) {
    return env.DB.prepare("SELECT status, is_active FROM shops WHERE id = ?").bind(shopId).first<{ status: string; is_active: number }>();
  }

  it("invite accept records the acceptance with document and version", async () => {
    const shopId = await seedShop("Invite Audit Shop");
    const invite = await seedInvite(shopId, "admin");
    const name = `Ada Onboarded ${crypto.randomUUID().slice(0, 6)}`;
    const password = secret("pw");
    const res = await dispatch("POST", `/api/invites/${invite.token}/accept`, {
      headers: { "CF-Connecting-IP": nextIp() },
      body: { name, password, accept_terms: true },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { data: { token: string } };
    expect(body).toEqual({ success: true, data: { token: expect.any(String), role: "admin", shop_id: shopId } });

    const user = await env.DB.prepare("SELECT id FROM platform_users WHERE email = ?").bind(invite.email).first<{ id: string }>();
    expect(user?.id).toBeTruthy();
    const acc = await env.DB.prepare("SELECT document, version FROM legal_acceptances WHERE user_id = ?")
      .bind(user!.id)
      .first<{ document: string; version: string }>();
    expect(acc).toEqual({ document: "terms_dpa", version: "1.0" });
    expect(await shopState(shopId)).toEqual({ status: "active", is_active: 1 });
    const used = await env.DB.prepare("SELECT used_at FROM invites WHERE id = ?").bind(invite.id).first<{ used_at: string | null }>();
    expect(used?.used_at).not.toBeNull();

    const rows = await rowsForRequest(rid(res), "account.invite.accept");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.phase).toBe("done");
    expect(row.outcome).toBe("succeeded");
    expect(row.entity_type).toBe("invite");
    expect(row.entity_id).toBe(invite.id);
    expect(row.shop_id).toBe(shopId);
    expect(row.actor_type).toBe("admin");
    expect(row.actor_ref).toBe(`subj_user_${user!.id}`);
    expect(JSON.parse(row.details_json as string)).toEqual({ user_id: user!.id, role: "admin", document: "terms_dpa", version: "1.0" });
    const subject = await env.DB.prepare("SELECT kind, user_id FROM audit_subjects WHERE id = ?")
      .bind(`subj_user_${user!.id}`)
      .first<{ kind: string; user_id: string }>();
    expect(subject).toEqual({ kind: "user", user_id: user!.id });
    expectClean(await rowsForRequest(rid(res)), [
      name,
      password,
      invite.email,
      invite.token,
      body.data.token,
      ...(await userValues(user!.id)),
      ...(await shopValues(shopId)),
    ]);
    expect(await gapRowsFor(rid(res))).toBe(0);

    // The same acceptance with no way to record it: none of the four writes happen.
    const offShop = await seedShop("Invite Audit Off Shop");
    const offInvite = await seedInvite(offShop, "admin");
    const before = await shopState(offShop);
    const off = await withAuditOff(() =>
      dispatch("POST", `/api/invites/${offInvite.token}/accept`, {
        headers: { "CF-Connecting-IP": nextIp() },
        body: { name: "Never Onboarded", password: secret("pw"), accept_terms: true },
      }),
    );
    expect(off.status).toBeGreaterThanOrEqual(500);
    const noUser = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_users WHERE email = ?").bind(offInvite.email).first<{ n: number }>();
    expect(noUser!.n).toBe(0);
    const noAcc = await env.DB.prepare("SELECT COUNT(*) AS n FROM legal_acceptances WHERE shop_id = ?").bind(offShop).first<{ n: number }>();
    expect(noAcc!.n).toBe(0);
    expect(await shopState(offShop)).toEqual(before);
    const unused = await env.DB.prepare("SELECT used_at FROM invites WHERE id = ?").bind(offInvite.id).first<{ used_at: string | null }>();
    expect(unused?.used_at).toBeNull();
  });
});

// ─── Enquiries ───────────────────────────────────────────────────────────────

describe("contact", () => {
  function enquiry() {
    return {
      full_name: `Enid Enquirer ${crypto.randomUUID().slice(0, 6)}`,
      shop_name: `Enid's Chairs ${crypto.randomUUID().slice(0, 6)}`,
      shop_type: "barber_shop",
      email: `enq-${crypto.randomUUID()}@enquiry.test`,
      phone: `07700 9${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
      message: `Please call me about pricing ${crypto.randomUUID()}`,
    };
  }

  for (const path of ["/api/contact", "/contact"]) {
    it(`enquiry records no name, email or message (${path})`, async () => {
      const form = enquiry();
      const res = await dispatch("POST", path, { headers: { "CF-Connecting-IP": nextIp() }, body: form });
      expect(res.status, await res.clone().text()).toBe(201);
      const body = (await res.json()) as { data: { id: string } };
      expect(body).toEqual({ success: true, data: { id: body.data.id } });

      const rows = await rowsForRequest(rid(res), "enquiry.create");
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.phase).toBe("done");
      expect(row.outcome).toBe("succeeded");
      expect(row.entity_type).toBe("contact");
      expect(row.entity_id).toBe(body.data.id);
      expect(row.shop_id).toBeNull();
      expect(row.actor_type).toBe("anonymous");
      expect(row.ip_ref).not.toBeNull();
      expect(row.changes_json).toBeNull();
      expect(JSON.parse(row.details_json as string)).toEqual({ shop_type: "barber_shop" });
      expectClean(await rowsForRequest(rid(res)), [form.full_name, form.shop_name, form.email, form.phone, form.message]);
      expect(await gapRowsFor(rid(res))).toBe(0);
    });
  }

  it("an enquiry that cannot be recorded is not stored", async () => {
    const form = enquiry();
    const res = await withAuditOff(() => dispatch("POST", "/api/contact", { headers: { "CF-Connecting-IP": nextIp() }, body: form }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = ?").bind(form.email).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});

// ─── Stripe webhook ──────────────────────────────────────────────────────────

describe("Stripe webhook", () => {
  async function seedAwaitingPayment() {
    const shopId = await seedShop("Webhook Audit Shop");
    const sessionId = `cs_test_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "UPDATE shops SET stripe_checkout_session_id = ?, stripe_payment_status = 'unpaid', status = 'awaiting_payment' WHERE id = ?",
    )
      .bind(sessionId, shopId)
      .run();
    const inviteId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO invites (id, email, shop_id, role, token, expires_at, active) VALUES (?, ?, ?, 'admin', ?, '2999-12-31T23:59:59Z', 0)`,
    )
      .bind(inviteId, `owner-${inviteId}@webhook.test`, shopId, `tok-${crypto.randomUUID()}`)
      .run();
    return { shopId, sessionId, inviteId };
  }

  const systemRecorder = () =>
    createAuditRecorder({ db: env.DB, worker: "pivot-parlor-api", via: "webhook", actor: { type: "system" }, requestId: null });

  async function rowsForEvent(eventId: string): Promise<Record<string, unknown>[]> {
    const r = await env.DB.prepare("SELECT * FROM audit_log WHERE action = 'payment.stripe.webhook' AND details_json LIKE ? ORDER BY rowid")
      .bind(`%${eventId}%`)
      .all<Record<string, unknown>>();
    return r.results ?? [];
  }

  async function paymentState(shopId: string, inviteId: string) {
    const shop = await env.DB.prepare("SELECT status, stripe_payment_status FROM shops WHERE id = ?")
      .bind(shopId)
      .first<{ status: string; stripe_payment_status: string }>();
    const invite = await env.DB.prepare("SELECT active FROM invites WHERE id = ?").bind(inviteId).first<{ active: number }>();
    return { ...shop, invite_active: invite?.active };
  }

  async function signed(event: unknown, signingSecret = String(env.STRIPE_WEBHOOK_SECRET)): Promise<Response> {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return dispatch("POST", "/api/webhooks/stripe", { headers: { "stripe-signature": `t=${t},v1=${hex}` }, body: event });
  }

  it("checkout webhook records the payment as system via webhook", async () => {
    const { shopId, sessionId, inviteId } = await seedAwaitingPayment();
    const eventId = `evt_${crypto.randomUUID()}`;
    const result = await handleCheckoutSessionCompleted(
      env.DB,
      { id: sessionId, metadata: { shop_id: shopId, invite_id: inviteId } },
      systemRecorder(),
      eventId,
    );
    expect(result).toEqual({ activated: true });
    expect(await paymentState(shopId, inviteId)).toEqual({ status: "pending", stripe_payment_status: "paid", invite_active: 1 });

    const rows = await entriesFor({ action: "payment.stripe.webhook", entityId: shopId });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.phase).toBe("done");
    expect(row.outcome).toBe("succeeded");
    expect(row.actor_type).toBe("system");
    expect(row.actor_ref).toBeNull();
    expect(row.via).toBe("webhook");
    expect(row.worker).toBe("pivot-parlor-api");
    expect(row.shop_id).toBe(shopId);
    expect(row.entity_type).toBe("shop");
    expect(JSON.parse(row.changes_json as string)).toEqual({
      status: ["awaiting_payment", "pending"],
      stripe_payment_status: ["unpaid", "paid"],
    });
    expect(JSON.parse(row.details_json as string)).toEqual({ event_id: eventId, event_type: "checkout.session.completed" });
    expectClean(rows, [sessionId, `owner-${inviteId}@webhook.test`, ...(await shopValues(shopId))]);
  });

  it("a redelivered checkout on an active shop records succeeded with no status change", async () => {
    const { shopId, sessionId, inviteId } = await seedAwaitingPayment();
    const session = { id: sessionId, metadata: { shop_id: shopId, invite_id: inviteId } };
    await handleCheckoutSessionCompleted(env.DB, session, systemRecorder(), `evt_${crypto.randomUUID()}`);
    await env.DB.prepare("UPDATE shops SET status = 'active' WHERE id = ?").bind(shopId).run();

    const eventId = `evt_${crypto.randomUUID()}`;
    const result = await handleCheckoutSessionCompleted(env.DB, session, systemRecorder(), eventId);
    expect(result).toEqual({ activated: true });
    expect(await paymentState(shopId, inviteId)).toEqual({ status: "active", stripe_payment_status: "paid", invite_active: 1 });

    const rows = await rowsForEvent(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("succeeded");
    expect(rows[0]!.shop_id).toBe(shopId);
    expect(rows[0]!.changes_json).toBeNull();
  });

  it("checkout without metadata records a refused webhook and changes nothing", async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const sessionId = `cs_test_${crypto.randomUUID()}`;
    const result = await handleCheckoutSessionCompleted(env.DB, { id: sessionId, metadata: {} }, systemRecorder(), eventId);
    expect(result).toEqual({ activated: false, reason: "missing_metadata" });
    const rows = await rowsForEvent(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("refused");
    expect(rows[0]!.reason).toBe("missing_metadata");
    expect(rows[0]!.shop_id).toBeNull();
    expect(rows[0]!.entity_id).toBeNull();
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ event_id: eventId, event_type: "checkout.session.completed" });
    expectClean(rows, [sessionId]);
  });

  it("checkout for an unknown session records shop_not_found, never the metadata shop id", async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const sessionId = `cs_test_${crypto.randomUUID()}`;
    const claimedShop = `claimed-${crypto.randomUUID()}`;
    const result = await handleCheckoutSessionCompleted(
      env.DB,
      { id: sessionId, metadata: { shop_id: claimedShop, invite_id: crypto.randomUUID() } },
      systemRecorder(),
      eventId,
    );
    expect(result).toEqual({ activated: false, reason: "shop_not_found" });
    const rows = await rowsForEvent(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("refused");
    expect(rows[0]!.reason).toBe("shop_not_found");
    expect(rows[0]!.shop_id).toBeNull();
    expectClean(rows, [sessionId, claimedShop]);
  });

  it("checkout marks the session's own shop, never a different metadata shop", async () => {
    const { shopId, sessionId, inviteId } = await seedAwaitingPayment();
    const otherShop = await seedShop("Metadata Other Shop");
    const eventId = `evt_${crypto.randomUUID()}`;
    await handleCheckoutSessionCompleted(
      env.DB,
      { id: sessionId, metadata: { shop_id: otherShop, invite_id: inviteId } },
      systemRecorder(),
      eventId,
    );
    expect(await paymentState(shopId, inviteId)).toEqual({ status: "pending", stripe_payment_status: "paid", invite_active: 1 });
    const other = await env.DB.prepare("SELECT stripe_payment_status FROM shops WHERE id = ?").bind(otherShop).first<{ stripe_payment_status: string | null }>();
    expect(other?.stripe_payment_status).not.toBe("paid");
    const rows = await rowsForEvent(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shop_id).toBe(shopId);
    expect(rows[0]!.entity_id).toBe(shopId);
  });

  it("checkout never activates an invite of a different shop named in the metadata", async () => {
    const paying = await seedAwaitingPayment();
    const other = await seedAwaitingPayment();
    const eventId = `evt_${crypto.randomUUID()}`;
    const result = await handleCheckoutSessionCompleted(
      env.DB,
      { id: paying.sessionId, metadata: { shop_id: paying.shopId, invite_id: other.inviteId } },
      systemRecorder(),
      eventId,
    );
    // The answer is unchanged: the paying shop is marked paid.
    expect(result).toEqual({ activated: true });
    expect(await paymentState(paying.shopId, paying.inviteId)).toEqual({ status: "pending", stripe_payment_status: "paid", invite_active: 0 });
    // The other shop's invite is untouched, and so is the other shop.
    expect(await paymentState(other.shopId, other.inviteId)).toEqual({
      status: "awaiting_payment",
      stripe_payment_status: "unpaid",
      invite_active: 0,
    });
    const rows = await rowsForEvent(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shop_id).toBe(paying.shopId);
    expectClean(rows, [paying.sessionId, other.sessionId, ...(await shopValues(other.shopId))]);
  });

  it("a signed checkout event records one system entry and no gap", async () => {
    const { shopId, sessionId, inviteId } = await seedAwaitingPayment();
    const eventId = `evt_${crypto.randomUUID()}`;
    const res = await signed({
      id: eventId,
      type: "checkout.session.completed",
      data: { object: { id: sessionId, metadata: { shop_id: shopId, invite_id: inviteId } } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    const rows = await rowsForRequest(rid(res));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("payment.stripe.webhook");
    expect(rows[0]!.outcome).toBe("succeeded");
    expect(rows[0]!.actor_type).toBe("system");
    expect(rows[0]!.via).toBe("webhook");
    expect(rows[0]!.shop_id).toBe(shopId);
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ event_id: eventId, event_type: "checkout.session.completed" });
    expectClean(rows, [sessionId, `owner-${inviteId}@webhook.test`, ...(await shopValues(shopId))]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("another verified event type records handled false", async () => {
    const customerId = `cus_${crypto.randomUUID()}`;
    const customerEmail = `stripe-customer-${crypto.randomUUID()}@webhook.test`;
    const res = await signed({
      id: `evt_${crypto.randomUUID()}`,
      type: "customer.created",
      data: { object: { id: customerId, email: customerEmail } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    const rows = await rowsForRequest(rid(res));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("payment.stripe.webhook");
    expect(rows[0]!.phase).toBe("done");
    expect(rows[0]!.outcome).toBe("succeeded");
    expect(rows[0]!.entity_id).toBeNull();
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ event_type: "customer.created", handled: false });
    expectClean(rows, [customerId, customerEmail]);
    expect(await gapRowsFor(rid(res))).toBe(0);
  });

  it("an event type or id outside Stripe's identifier shape is recorded as null", async () => {
    const odd = `Call me on 07700 900123 ${crypto.randomUUID()}`;
    const res = await signed({ id: `evt_${crypto.randomUUID()}`, type: odd, data: { object: {} } });
    expect(res.status).toBe(200);
    const rows = await rowsForRequest(rid(res));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.details_json as string)).toEqual({ event_type: null, handled: false });
    expectClean(rows, [odd]);

    const { shopId, sessionId, inviteId } = await seedAwaitingPayment();
    const oddId = `evt with spaces ${crypto.randomUUID()}`;
    await handleCheckoutSessionCompleted(env.DB, { id: sessionId, metadata: { shop_id: shopId, invite_id: inviteId } }, systemRecorder(), oddId);
    const entry = (await entriesFor({ action: "payment.stripe.webhook", entityId: shopId }))[0]!;
    expect(JSON.parse(entry.details_json as string)).toEqual({ event_id: null, event_type: "checkout.session.completed" });
    expectClean([entry], [oddId, sessionId, `owner-${inviteId}@webhook.test`, ...(await shopValues(shopId))]);
  });

  it("a bad signature writes nothing", async () => {
    const res = await signed({ id: `evt_${crypto.randomUUID()}`, type: "checkout.session.completed", data: { object: { id: "cs_x" } } }, secret("whwrong"));
    expect(res.status).toBe(400);
    expect(await rowsForRequest(rid(res))).toHaveLength(0);
  });

  it("an unrecordable checkout event changes nothing, so Stripe retries it", async () => {
    const { shopId, sessionId, inviteId } = await seedAwaitingPayment();
    const res = await withAuditOff(() =>
      signed({
        id: `evt_${crypto.randomUUID()}`,
        type: "checkout.session.completed",
        data: { object: { id: sessionId, metadata: { shop_id: shopId, invite_id: inviteId } } },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await paymentState(shopId, inviteId)).toEqual({ status: "awaiting_payment", stripe_payment_status: "unpaid", invite_active: 0 });
  });

  it("an unrecordable other event answers 503, so Stripe retries it", async () => {
    const res = await withAuditOff(() => signed({ id: `evt_${crypto.randomUUID()}`, type: "customer.created", data: { object: {} } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: AUDIT_REFUSED_MESSAGE });
  });
});
