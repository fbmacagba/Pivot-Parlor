import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

/**
 * The public contact form (POST /api/contact):
 * - Each text field has a length cap. A value at the cap is stored whole; one
 *   character more is a 400 that stores nothing. Line breaks count as one
 *   character, as the browser's maxlength counts them, although a browser
 *   submits each one as CRLF.
 * - No log line carries what the enquirer typed (name, email, phone, shop
 *   name, message or an unknown shop type). Workers Logs keeps every line,
 *   and an enquirer's name and email are personal data.
 */

let ipSeq = 0;
/** A fresh address per request, so the contact limiter (5 an hour per IP) never answers in the route's place. */
function nextIp(): string {
  ipSeq += 1;
  return `10.88.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

type Sent = { status: number; body: { success?: boolean; error?: string; data?: { id?: string } } | null };

async function post(value: unknown, raw?: string): Promise<Sent> {
  const ctx = createExecutionContext();
  const res = (await worker.fetch(
    new Request("https://worker.test/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": nextIp() },
      body: raw ?? JSON.stringify(value),
    }) as never,
    env as never,
    ctx as never,
  )) as unknown as Response;
  await waitOnExecutionContext(ctx);
  let body: Sent["body"] = null;
  try {
    body = (await res.json()) as Sent["body"];
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function contactCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts").first<{ n: number }>();
  return row!.n;
}

const enquiry = {
  full_name: "Casey Example",
  shop_name: "Example Cuts",
  shop_type: "barber_shop",
  email: "casey@example.test",
  phone: "07700 900123",
  message: "Hello",
};

// The caps, written out here so a change to the shared constant is a visible test change.
const LIMITS = { full_name: 120, shop_name: 120, email: 254, phone: 40, message: 2000 } as const;
type Field = keyof typeof LIMITS;

/** A value of exactly `length` characters that the route accepts for `field`. */
function valueOf(field: Field, length: number): string {
  if (field === "email") {
    const domain = "@example.test";
    return "a".repeat(length - domain.length) + domain;
  }
  return "x".repeat(length);
}

describe("contact field length caps", () => {
  it.each(Object.keys(LIMITS) as Field[])("%s: at its cap is stored whole (201)", async (field) => {
    const value = valueOf(field, LIMITS[field]);
    const r = await post({ ...enquiry, [field]: value });
    expect(r.status).toBe(201);
    const row = await env.DB.prepare(`SELECT ${field} AS v FROM contacts WHERE id = ?`)
      .bind(r.body!.data!.id)
      .first<{ v: string }>();
    expect(row!.v.length).toBe(LIMITS[field]);
  });

  it.each(Object.keys(LIMITS) as Field[])("%s: one character over its cap is a 400 that stores nothing", async (field) => {
    const before = await contactCount();
    const r = await post({ ...enquiry, [field]: valueOf(field, LIMITS[field] + 1) });
    expect(r).toEqual({
      status: 400,
      body: { success: false, error: `${field} is too long (${LIMITS[field]} characters at most)` },
    });
    expect(await contactCount()).toBe(before);
  });

  it("measures after trimming, as the value is stored", async () => {
    const r = await post({ ...enquiry, phone: `   ${"7".repeat(LIMITS.phone)}   ` });
    expect(r.status).toBe(201);
  });

  it("counts a CRLF line break in the message as one character, as maxlength does", async () => {
    // What a browser submits for a textarea filled to exactly its maxlength:
    // ten lines of 199 characters and nine breaks (each counted once) make
    // 1999, and one more character makes 2000. Sent as CRLF it is 2009 long.
    const atCap = Array.from({ length: 10 }, () => "m".repeat(199)).join("\r\n") + "m";
    expect(atCap.length).toBe(LIMITS.message + 9);
    expect(atCap.replace(/\r\n/g, "\n").length).toBe(LIMITS.message);

    const ok = await post({ ...enquiry, message: atCap });
    expect(ok.status).toBe(201);

    const before = await contactCount();
    const over = await post({ ...enquiry, message: `${atCap}m` });
    expect(over).toEqual({
      status: 400,
      body: { success: false, error: `message is too long (${LIMITS.message} characters at most)` },
    });
    expect(await contactCount()).toBe(before);
  });
});

describe("contact logs carry nothing the enquirer typed", () => {
  // Distinctive values, so a match can only be an echo of this input. The
  // email is mixed case because the route lowercases it: the check below is
  // case-insensitive, so a lowercased echo is caught too.
  const typed = {
    full_name: "Quillon Brackenridge",
    shop_name: "Brackenridge Fades",
    email: "Quillon.Brackenridge+pii7@Example.test",
    phone: "07700 900461",
    message: "Zephyrine would like a demo on Thursday",
  };
  const NEEDLES = [...Object.values(typed), "Gondolier Studio"];

  const METHODS = ["log", "warn", "error", "info", "debug"] as const;
  let lines: string[] = [];

  function spyOnConsole(): void {
    lines = [];
    for (const method of METHODS) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(
          args
            .map((a) => {
              if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
              if (typeof a === "string") return a;
              try {
                return JSON.stringify(a);
              } catch {
                return String(a);
              }
            })
            .join(" "),
        );
      });
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function echoes(): string[] {
    const found: string[] = [];
    for (const line of lines) {
      for (const needle of NEEDLES) {
        if (line.toLowerCase().includes(needle.toLowerCase())) found.push(`${needle} in: ${line}`);
      }
    }
    return found;
  }

  it.each([
    ["a valid enquiry", { ...typed, shop_type: "barber_shop" }, 201],
    ["a missing field", { ...typed, shop_type: "barber_shop", message: "" }, 400],
    ["an unknown shop type", { ...typed, shop_type: "Gondolier Studio" }, 400],
    ["an over-length field", { ...typed, shop_type: "barber_shop", full_name: `${typed.full_name} ${"z".repeat(200)}` }, 400],
  ])("%s logs none of it", async (_case, body, status) => {
    spyOnConsole();
    const r = await post(body);
    expect(r.status).toBe(status);
    expect(echoes()).toEqual([]);
  });

  it("a malformed body logs none of it", async () => {
    spyOnConsole();
    const r = await post(null, `["${typed.full_name}", "${typed.email}"]`);
    expect(r.status).toBe(400);
    expect(echoes()).toEqual([]);
  });

  it("the spy sees the route's own log lines (control)", async () => {
    spyOnConsole();
    const r = await post({ ...typed, shop_type: "barber_shop" });
    expect(r.status).toBe(201);
    expect(lines.some((line) => line.includes("[worker contact] stored enquiry"))).toBe(true);
  });
});
