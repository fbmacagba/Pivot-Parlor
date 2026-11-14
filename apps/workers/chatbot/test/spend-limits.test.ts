import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAuditDb, type FakeAuditDb } from "@repo/audit/testing";
import app from "../src/index";

/**
 * What one day of shop-site chat can cost.
 *
 * Every model reply is paid for. The per-shop limits (50 an hour, 200 a day)
 * and the per-visitor limit (30 an hour) each stop one source, but the most a
 * day can cost grew with the number of shops. So:
 * - a chat for a shop whose site the public cannot see (draft, paused, or no
 *   published site) is refused like an unknown shop, before anything is spent;
 * - all shops together get at most 1,000 replies a UTC day, and the owner is
 *   told, once a day, when visitors start being turned away.
 */

// The schema assertion reads PRAGMA table_info through db.batch; this suite
// has no real D1, so it is bypassed (its own behaviour is not under test).
vi.mock("../src/ensure-schema", () => ({ assertChatbotSchema: async () => undefined }));

const NOW = new Date("2026-07-02T12:00:00Z");
const DAY = "2026-07-02";
const HOUR = "2026-07-02-12";
const IP = "203.0.113.9";
const SHOP = { id: "shop-1", name: "Linden", type: "barber", slug: "linden" };
const MESSAGE = "do you have any slots free on Saturday afternoon?";
const MODEL_REPLY = "Yes, we have a 3pm slot on Saturday.";
const FALLBACK_REPLY = "I'm having a quick moment. Please try again, or book directly at the link above.";
const PLATFORM_KEY = `rate:chat:platform:day:${DAY}`;
const NOT_FOUND = { reply: FALLBACK_REPLY, error: "Shop not found" };
const RATE_LIMITED = { error: "rate_limit", message: "Too many messages. Please try again later." };

function memoryKv(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
  };
}
type MemoryKv = ReturnType<typeof memoryKv>;

/** fakeAuditDb plus the `.all()` the shop-context reader uses (no rows). */
function chatDb(fake: FakeAuditDb): FakeAuditDb {
  const realPrepare = fake.db.prepare.bind(fake.db);
  type Stmt = { bind(...a: unknown[]): Stmt };
  const withAll = (stmt: Stmt): Stmt & { all(): Promise<{ results: unknown[] }> } => ({
    ...stmt,
    bind: (...a: unknown[]) => withAll(stmt.bind(...a)),
    all: async () => ({ results: [] }),
  });
  (fake.db as unknown as { prepare: (sql: string) => Stmt }).prepare = (sql: string) =>
    withAll(realPrepare(sql) as unknown as Stmt);
  return fake;
}

/** `websiteStatus` is the shop's published site status; null means no published site. */
function setup(opts: { websiteStatus?: string | null; kv?: Record<string, string> } = {}) {
  const websiteStatus = opts.websiteStatus === undefined ? "live" : opts.websiteStatus;
  const fake = chatDb(
    fakeAuditDb({
      answer: (sql) => (sql.startsWith("SELECT id, name, type, slug") ? { ...SHOP, website_status: websiteStatus } : null),
    }),
  );
  const kv = memoryKv(opts.kv ?? {});
  const env = { DB: fake.db, KV: kv, OPENROUTER_API_KEY: "or-key", ENVIRONMENT: "test", PLATFORM_URL: "https://pivotparlor.com" };
  return { fake, kv, env };
}

async function chat(env: unknown): Promise<{ status: number; body: unknown }> {
  const res = await app.request(
    "/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP },
      body: JSON.stringify({ shopId: SHOP.id, message: MESSAGE }),
    },
    env as never,
  );
  return { status: res.status, body: await res.json() };
}

/** The rate counters, as stored. */
const counters = (kv: MemoryKv) =>
  Object.fromEntries([...kv.store].filter(([k]) => k.startsWith("rate:chat:")));

let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn(async () =>
    Response.json({ choices: [{ message: { content: MODEL_REPLY } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /chat for a shop whose site the public cannot see", () => {
  it.each([
    ["a draft site", "draft"],
    ["a paused site", "paused"],
    ["no published site", null],
  ])("%s answers 404 like an unknown shop and spends nothing", async (_kind, websiteStatus) => {
    const { fake, kv, env } = setup({ websiteStatus });
    expect(await chat(env)).toEqual({ status: 404, body: NOT_FOUND });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counters(kv)).toEqual({});
    expect(fake.rows).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each(["live", "LIVE"])("a published site (%s) is answered (control)", async (websiteStatus) => {
    const { env } = setup({ websiteStatus });
    expect(await chat(env)).toEqual({ status: 200, body: { reply: MODEL_REPLY } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /chat, the platform-wide daily cap of 1,000 replies", () => {
  it("every answered chat counts toward the platform's day", async () => {
    const { kv, env } = setup();
    expect((await chat(env)).status).toBe(200);
    expect(kv.store.get(PLATFORM_KEY)).toBe("1");
  });

  it("at 1,000 today, a shop that has used none of its own allowance gets the usual 429, and nothing is counted", async () => {
    const { fake, kv, env } = setup({ kv: { [PLATFORM_KEY]: "1000" } });
    expect(await chat(env)).toEqual({ status: 429, body: RATE_LIMITED });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows).toEqual([]);
    expect(counters(kv)).toEqual({ [PLATFORM_KEY]: "1000" });
  });

  it("the 1,000th reply of the day is answered and counted, and the next is refused", async () => {
    const { kv, env } = setup({ kv: { [PLATFORM_KEY]: "999" } });
    expect(await chat(env)).toEqual({ status: 200, body: { reply: MODEL_REPLY } });
    expect(kv.store.get(PLATFORM_KEY)).toBe("1000");
    expect(await chat(env)).toEqual({ status: 429, body: RATE_LIMITED });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("yesterday's count does not carry over (control)", async () => {
    const { env } = setup({ kv: { "rate:chat:platform:day:2026-07-01": "1000" } });
    expect(await chat(env)).toEqual({ status: 200, body: { reply: MODEL_REPLY } });
  });
});

describe("POST /chat, telling the owner the cap was reached", () => {
  it("the first refusal at the cap logs one error with no visitor data; the rest of the day stays quiet", async () => {
    const { env } = setup({ kv: { [PLATFORM_KEY]: "1000" } });
    for (let i = 0; i < 3; i++) expect((await chat(env)).status).toBe(429);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toMatch(/platform/i);
    expect(logged).toMatch(/1,?000/);
    expect(logged).not.toContain(IP);
    expect(logged).not.toContain(SHOP.id);
    expect(logged).not.toContain(MESSAGE);
  });

  it.each([
    ["the shop's day", `rate:chat:${SHOP.id}:day:${DAY}`, "200"],
    ["the shop's hour", `rate:chat:${SHOP.id}:hour:${HOUR}`, "50"],
    ["the visitor's hour", `rate:chat:ip:${IP}:hour:${HOUR}`, "30"],
  ])("a 429 for %s is not the platform cap and logs no error", async (_kind, key, count) => {
    const { env } = setup({ kv: { [key]: count } });
    expect(await chat(env)).toEqual({ status: 429, body: RATE_LIMITED });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
