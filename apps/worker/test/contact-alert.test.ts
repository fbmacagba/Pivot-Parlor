import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

/**
 * A stored enquiry emails the platform inbox (ENQUIRY_ALERT_TO), so a lead
 * from the contact form is seen the day it arrives, not whenever someone next
 * opens the developer dashboard.
 *
 * - One email per stored enquiry, to ENQUIRY_ALERT_TO, replying to the
 *   enquirer when their address is a plausible single address.
 * - Everything the enquirer typed is escaped: the form is public.
 * - The visitor's answer never depends on the email: a refused send is
 *   logged (no enquirer data) and the enquiry stays stored.
 * - Recorded as `enquiry.alert`, naming the enquiry and never the enquirer.
 * - Unset ENQUIRY_ALERT_TO or RESEND_API_KEY (staging, local) sends nothing,
 *   and production's wrangler.toml is the only place that sets the address.
 */

const RESEND = "https://api.resend.com/emails";
const ALERT_TO = "enquiries@example.test";
const RESEND_KEY = "test-resend-key";

let ipSeq = 0;
/** A fresh address per request, so the contact limiter (5 an hour per IP) never answers in the route's place. */
function nextIp(): string {
  ipSeq += 1;
  return `10.88.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

const enquiry = {
  full_name: "Casey Example",
  shop_name: "Example Cuts",
  shop_type: "barber_shop",
  email: "casey@example.test",
  phone: "+44 7700 900123",
  message: "Hello\nWe would like a booking page.",
};

type Sent = { from?: string; to?: unknown; subject?: string; html?: string; reply_to?: unknown };
type Outcome = {
  status: number;
  body: { success?: boolean; data?: { id?: string }; error?: string } | null;
  sent: Sent[];
  requestId: string | null;
};

async function post(
  value: unknown,
  opts: { alertTo?: string | null; resendKey?: string | null; resend?: () => Response | Promise<Response> } = {},
): Promise<Outcome> {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== RESEND) return realFetch(input, init);
      sent.push(JSON.parse(String(init?.body ?? "{}")) as Sent);
      return opts.resend ? opts.resend() : Response.json({ id: "sent-in-test" });
    }),
  );
  const testEnv = {
    ...env,
    TURNSTILE_SECRET_KEY: undefined,
    RESEND_API_KEY: opts.resendKey === null ? undefined : (opts.resendKey ?? RESEND_KEY),
    ENQUIRY_ALERT_TO: opts.alertTo === null ? undefined : (opts.alertTo ?? ALERT_TO),
  };
  const ctx = createExecutionContext();
  const res = (await worker.fetch(
    new Request("https://worker.test/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
      body: JSON.stringify(value),
    }) as never,
    testEnv as never,
    ctx as never,
  )) as unknown as Response;
  await waitOnExecutionContext(ctx);
  let body: Outcome["body"] = null;
  try {
    body = (await res.json()) as Outcome["body"];
  } catch {
    body = null;
  }
  return { status: res.status, body, sent, requestId: res.headers.get("X-Request-Id") };
}

async function auditRows(requestId: string, action: string): Promise<Record<string, unknown>[]> {
  const r = await env.DB.prepare("SELECT * FROM audit_log WHERE request_id = ? AND action = ? ORDER BY occurred_at, rowid")
    .bind(requestId, action)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

/** Every console line written while `fn` runs, as text. */
async function captureLogs(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" "));
    });
  }
  await fn();
  return lines;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/contact emails the platform inbox", () => {
  it("sends one email per stored enquiry to ENQUIRY_ALERT_TO, replying to the enquirer", async () => {
    const r = await post(enquiry);
    expect(r.status).toBe(201);
    expect(r.sent).toHaveLength(1);
    const mail = r.sent[0]!;
    expect(mail.to).toBe(ALERT_TO);
    expect(mail.reply_to).toBe("casey@example.test");
    expect(mail.subject).toBe("New enquiry: Example Cuts");
    for (const shown of ["Casey Example", "Example Cuts", "Barber shop", "casey@example.test", "+44 7700 900123", "Hello", "We would like a booking page."]) {
      expect(mail.html, `the email shows ${shown}`).toContain(shown);
    }
  });

  it("escapes everything the enquirer typed", async () => {
    const r = await post({
      ...enquiry,
      full_name: '<img src=x onerror="alert(1)">',
      shop_name: "Cuts & <b>Co</b>",
      message: "<script>steal()</script>",
    });
    expect(r.status).toBe(201);
    const html = r.sent[0]!.html!;
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>steal");
    expect(html).not.toContain("<b>Co</b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("Cuts &amp; &lt;b&gt;Co&lt;/b&gt;");
  });

  it("keeps the subject on one line whatever the shop name holds", async () => {
    const r = await post({ ...enquiry, shop_name: "Example\r\nBcc: someone@example.test  Cuts" });
    expect(r.sent[0]!.subject).toBe("New enquiry: Example Bcc: someone@example.test Cuts");
  });

  it.each([
    ["no @ at all", "not-an-address"],
    ["two addresses", "a@example.test, b@example.test"],
    ["a space inside", "casey @example.test"],
    ["no dot in the domain", "casey@localhost"],
  ])("still sends the alert, with no reply-to, when the address has %s", async (_label, email) => {
    const r = await post({ ...enquiry, email });
    expect(r.status).toBe(201);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.reply_to).toBeUndefined();
    expect(r.sent[0]!.html).toContain(email.replace(/&/g, "&amp;"));
  });

  it("records enquiry.alert for the stored enquiry, with nothing the enquirer typed", async () => {
    const r = await post(enquiry);
    const id = r.body?.data?.id;
    expect(id).toMatch(/.+/);
    const rows = await auditRows(r.requestId!, "enquiry.alert");
    expect(rows.map((row) => row.phase)).toEqual(["started", "outcome"]);
    expect(rows[1]).toMatchObject({ outcome: "succeeded", entity_type: "contact", entity_id: id });
    const stored = JSON.stringify(rows);
    for (const typed of ["Casey Example", "Example Cuts", "casey@example.test", "900123", ALERT_TO]) {
      expect(stored, `the entry must not hold ${typed}`).not.toContain(typed);
    }
  });

  it("still answers 201 and keeps the enquiry when Resend refuses, logging a reason with no enquirer data", async () => {
    let r!: Outcome;
    const lines = await captureLogs(async () => {
      r = await post(enquiry, { resend: () => new Response('{"name":"application_error"}', { status: 500 }) });
    });
    expect(r.status).toBe(201);
    const id = r.body?.data?.id;
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id = ?").bind(id).first<{ n: number }>();
    expect(stored?.n).toBe(1);
    const rows = await auditRows(r.requestId!, "enquiry.alert");
    expect(rows.at(-1)).toMatchObject({ phase: "outcome", outcome: "failed" });
    const logged = lines.join("\n");
    expect(logged).toContain("HTTP 500");
    for (const typed of ["Casey Example", "Example Cuts", "casey@example.test", "900123"]) {
      expect(logged, `no log line may hold ${typed}`).not.toContain(typed);
    }
  });

  it("still answers 201 when Resend cannot be reached", async () => {
    const r = await post(enquiry, {
      resend: () => {
        throw new TypeError("network down");
      },
    });
    expect(r.status).toBe(201);
    expect(r.sent).toHaveLength(1);
  });

  it("sends nothing for an enquiry it refuses", async () => {
    const r = await post({ ...enquiry, shop_type: "not-a-type" });
    expect(r.status).toBe(400);
    expect(r.sent).toEqual([]);
  });
});

describe("POST /api/contact without an alert address or key (staging, local)", () => {
  it("stores the enquiry and sends nothing when ENQUIRY_ALERT_TO is unset", async () => {
    const r = await post(enquiry, { alertTo: null });
    expect(r.status).toBe(201);
    expect(r.sent).toEqual([]);
  });

  it("stores the enquiry and sends nothing when RESEND_API_KEY is unset", async () => {
    const r = await post(enquiry, { resendKey: null });
    expect(r.status).toBe(201);
    expect(r.sent).toEqual([]);
  });
});

describe("ENQUIRY_ALERT_TO in wrangler.toml", () => {
  const toml = Object.values(
    import.meta.glob("../wrangler.toml", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
  )[0]!;

  /** The `KEY = "value"` lines of each [section], by section name. */
  function sections(text: string): Map<string, Map<string, string>> {
    const out = new Map<string, Map<string, string>>();
    let current = "";
    out.set(current, new Map());
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[+([^\]]+)\]+$/.exec(line);
      if (header) {
        current = header[1]!.trim();
        if (!out.has(current)) out.set(current, new Map());
        continue;
      }
      const kv = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
      if (kv) out.get(current)!.set(kv[1]!, kv[2]!);
    }
    return out;
  }

  it("production sends alerts to the platform inbox", () => {
    expect(sections(toml).get("vars")?.get("ENQUIRY_ALERT_TO")).toBe("dev@pivotparlor.com");
  });

  it("staging sets no alert address, so staging E2E never emails the inbox", () => {
    const staging = sections(toml).get("env.staging.vars");
    expect(staging, "the [env.staging.vars] section exists").toBeDefined();
    expect(staging!.has("ENQUIRY_ALERT_TO")).toBe(false);
  });
});
