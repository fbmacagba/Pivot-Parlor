/** A customer who replies to their booking confirmation reaches the shop:
 *  the email's reply-to is the shop's owner_email (every shop has one), when
 *  it is one plausible address. A doubtful one is left out rather than risk
 *  Resend refusing the whole confirmation. */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBookingSideEffects, type BookingSideEffectArgs } from "../src/services/booking-side-effects";
import { seedShop } from "./helpers";

type Sent = { to?: unknown; subject?: string; reply_to?: unknown };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs the side effects for a booking at `shopId` and returns every email sent. */
async function confirm(shopId: string): Promise<Sent[]> {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://api.resend.com/emails") sent.push(JSON.parse(String(init?.body ?? "{}")) as Sent);
    return Response.json({ id: "sent-in-test" });
  });
  const args: BookingSideEffectArgs = {
    bookingId: crypto.randomUUID(),
    shopId,
    shopName: "Reply Test Barbers",
    shopSlug: "reply-test",
    customerName: "Ada Fictional",
    customerEmail: "ada@example.test",
    serviceName: "Skin fade",
    staffName: "Kofi",
    bookingDate: "2027-03-01",
    startISO: "2027-03-01T10:00:00.000Z",
    timezone: "Europe/London",
    durationMin: 30,
    amountPence: 2500,
  };
  // No queue: only the confirmation is under test.
  await runBookingSideEffects({ ...env, RESEND_API_KEY: "test-resend-key", QUEUE: undefined } as never, args);
  return sent;
}

async function ownerEmail(shopId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT owner_email FROM shops WHERE id = ?").bind(shopId).first<{ owner_email: string }>();
  return row!.owner_email;
}

describe("booking confirmation reply-to", () => {
  it("replies to the shop's owner email", async () => {
    const shopId = await seedShop("Reply Test Barbers");
    const sent = await confirm(shopId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ada@example.test");
    expect(sent[0]!.reply_to).toBe(await ownerEmail(shopId));
  });

  it("still sends, with no reply-to, when the shop's email is not one plausible address", async () => {
    const shopId = await seedShop("Reply Odd Barbers");
    await env.DB.prepare("UPDATE shops SET owner_email = ? WHERE id = ?").bind(`two@example.test, ${shopId}@example.test`, shopId).run();
    const sent = await confirm(shopId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.reply_to).toBeUndefined();
  });

  it("still sends for a shop with no settings row (control)", async () => {
    const shopId = await seedShop("Reply No Settings");
    const sent = await confirm(shopId);
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when the shop turned confirmations off (control)", async () => {
    const shopId = await seedShop("Reply Off Barbers");
    await env.DB.prepare("INSERT INTO shop_settings (shop_id, booking_confirmation_email) VALUES (?, 0)").bind(shopId).run();
    expect(await confirm(shopId)).toEqual([]);
  });
});
