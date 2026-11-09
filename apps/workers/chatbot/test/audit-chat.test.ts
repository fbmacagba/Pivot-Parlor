import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAuditDb, type FakeAuditDb } from "@repo/audit/testing";
import app from "../src/index";
import { DEFAULT_CHATBOT_MODEL } from "../src/model";

// The schema assertion reads PRAGMA table_info through db.batch; this suite
// has no real D1, so it is bypassed (its own behaviour is not under test).
vi.mock("../src/ensure-schema", () => ({ assertChatbotSchema: async () => undefined }));

const SHOP = { id: "shop-1", name: "Linden", type: "barber", slug: "linden" };
const VISITOR_MESSAGE = "do you have any slots free on Saturday afternoon?";
const MODEL_REPLY = "Yes, we have a 3pm slot on Saturday.";

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  };
}

/** fakeAuditDb plus the `.all()` the shop-context reader uses (no rows). */
function chatDb(fake: FakeAuditDb): FakeAuditDb {
  const realPrepare = fake.db.prepare.bind(fake.db);
  const withAll = (stmt: any): any => ({
    ...stmt,
    bind: (...a: unknown[]) => withAll(stmt.bind(...a)),
    all: async () => ({ results: [] }),
  });
  (fake.db as any).prepare = (sql: string) => withAll(realPrepare(sql));
  return fake;
}

function setup(opts: { auditFail?: "all"; models?: unknown[] } = {}) {
  const fake = chatDb(
    fakeAuditDb({
      failAuditWrites: opts.auditFail,
      answer: (sql) => (sql.startsWith("SELECT id, name, type, slug FROM shops") ? SHOP : null),
    })
  );
  const kv = memoryKv(opts.models ? { "ai:models:v3": JSON.stringify(opts.models) } : {});
  const env = { DB: fake.db, KV: kv, OPENROUTER_API_KEY: "or-key", ENVIRONMENT: "test", PLATFORM_URL: "https://pivotparlor.com" };
  return { fake, env };
}

function chat(env: unknown, message: string, headers: Record<string, string> = {}) {
  return app.request(
    "/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ shopId: SHOP.id, message }),
    },
    env as never
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () =>
    Response.json({ choices: [{ message: { content: MODEL_REPLY } }], usage: { prompt_tokens: 100, completion_tokens: 20 } })
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chatbot audit", () => {
  it("a reply is one ai.call by an anonymous visitor with an IP subject", async () => {
    const { fake, env } = setup();
    const res = await chat(env, VISITOR_MESSAGE, { "CF-Connecting-IP": "203.0.113.9" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: MODEL_REPLY });

    expect(fake.rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
    const outcome = fake.rows[1]!;
    expect(outcome.action).toBe("ai.call");
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.actor_type).toBe("anonymous");
    expect(String(outcome.ip_ref)).toMatch(/^subj_ip_/);
    expect(outcome.entity_type).toBe("shop");
    expect(outcome.entity_id).toBe(SHOP.id);
    expect(outcome.worker).toBe("pivot-parlor-chatbot");
    const details = JSON.parse(String(outcome.details_json));
    expect(details.purpose).toBe("chatbot");
    expect(details.model).toBe(DEFAULT_CHATBOT_MODEL);
    expect(details.route).toBe("openrouter");
    expect(details.input_tokens).toBe(100);
    expect(details.output_tokens).toBe(20);

    const everything = JSON.stringify(fake.rows);
    expect(everything).not.toContain(VISITOR_MESSAGE);
    expect(everything).not.toContain(MODEL_REPLY);
    expect(everything).not.toContain("203.0.113.9");
  });

  it("a request with no CF-Connecting-IP records no IP subject", async () => {
    const { fake, env } = setup();
    const res = await chat(env, VISITOR_MESSAGE);
    expect(res.status).toBe(200);
    expect(fake.rows).toHaveLength(2);
    for (const r of fake.rows) {
      expect(r.actor_type).toBe("anonymous");
      expect(r.ip_ref).toBeNull();
    }
    expect(fake.statements.filter((s) => s.sql.includes("audit_subjects"))).toEqual([]);
  });

  it("a refused audit write answers 503 and never calls the model", async () => {
    const { fake, env } = setup({ auditFail: "all" });
    const res = await chat(env, VISITOR_MESSAGE, { "CF-Connecting-IP": "203.0.113.9" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      reply: "I'm having a quick moment. Please try again, or book directly at the link above.",
      error: "Could not record this action; nothing was changed.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows).toEqual([]);
    expect(fake.statements.filter((s) => s.sql.includes("ai_usage_log"))).toEqual([]);
  });

  it("the platform referral reply calls no model and writes nothing", async () => {
    const { fake, env } = setup();
    const res = await chat(env, "who made this website?", { "CF-Connecting-IP": "203.0.113.9" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: string }).reply).toContain("Pivot Parlor");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows).toEqual([]);
    expect(fake.statements.filter((s) => s.sql.includes("ai_usage_log"))).toEqual([]);
  });

  it("a failed model call records a failed outcome with no message text and answers the fallback", async () => {
    const { fake, env } = setup();
    fetchMock.mockImplementation(async () => new Response("provider says: " + VISITOR_MESSAGE, { status: 500 }));
    const res = await chat(env, VISITOR_MESSAGE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reply: "I'm having a quick moment. Please try again, or book directly at the link above.",
    });
    expect(fake.rows.map((r) => [r.phase, r.outcome])).toEqual([
      ["started", null],
      ["outcome", "failed"],
    ]);
    expect(String(fake.rows[1]!.reason)).toContain("ChatReplyFailedError");
    expect(JSON.stringify(fake.rows)).not.toContain(VISITOR_MESSAGE);
    expect(fake.statements.filter((s) => s.sql.includes("ai_usage_log"))).toEqual([]);
  });

  it("usage is logged through recordAiUsage, priced from the model list, under the audit request id", async () => {
    const { fake, env } = setup({
      models: [{ id: DEFAULT_CHATBOT_MODEL, costPer1MInput: 1, costPer1MOutput: 2, livePricing: true }],
    });
    const res = await chat(env, VISITOR_MESSAGE);
    expect(res.status).toBe(200);

    const usage = fake.statements.filter((s) => s.sql.includes("INSERT INTO ai_usage_log"));
    expect(usage).toHaveLength(1);
    const [, shopId, workerName, model, usageType, input, output, total, cost, basis, jobId] = usage[0]!.args;
    expect(shopId).toBe(SHOP.id);
    expect(workerName).toBe("pivot-parlor-chatbot");
    expect(model).toBe(DEFAULT_CHATBOT_MODEL);
    expect(usageType).toBe("chatbot");
    expect([input, output, total]).toEqual([100, 20, 120]);
    expect(cost).toBe(0.00014);
    expect(basis).toBe("live");
    expect(String(jobId)).toMatch(/^public-chat:[0-9a-f-]{36}$/);

    const outcome = fake.rows[1]!;
    expect(String(jobId)).toBe(`public-chat:${String(outcome.request_id)}`);
    const details = JSON.parse(String(outcome.details_json));
    expect(details.estimated_cost_usd).toBe(0.00014);
    expect(details.cost_basis).toBe("live");
  });
});
