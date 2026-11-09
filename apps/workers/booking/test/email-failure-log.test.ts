/** A confirmation Resend refuses logs its HTTP status and Resend's error
 *  code (the twin of apps/worker/test/email-failure-log.test.ts). Resend's
 *  message can echo the recipient, so it never reaches the log. Every
 *  credential is generated at runtime. */
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { sendBookingConfirmation, type BookingEmailData } from "../src/services/email";

afterEach(() => {
  vi.restoreAllMocks();
});

const to = `failing-${crypto.randomUUID()}@resend-log.test`;

const booking: BookingEmailData = {
  customer_name: "Ada Fictional",
  customer_email: to,
  service_name: "Skin fade",
  staff_name: "Kofi",
  shop_name: "Linden Test Barbers",
  shop_slug: "linden-test",
  booking_date: "2026-12-01",
  start_time: "2026-12-01T10:00:00.000Z",
  timezone: "Europe/London",
  duration_min: 30,
  amount_pence: 2500,
  booking_id: crypto.randomUUID(),
};

function resendAnswers(status: number, body: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));
}

function lines(spy: MockInstance): string[] {
  return spy.mock.calls.map((args) => args.map(String).join(" "));
}

async function failedSend(): Promise<{ err: unknown; logged: string[] }> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const err = await sendBookingConfirmation(`resend-${crypto.randomUUID()}`, booking).then(
    () => null,
    (e: unknown) => e,
  );
  return { err, logged: lines(errors) };
}

describe("a confirmation Resend refuses", () => {
  it("logs the HTTP status and Resend's error code, never its message", async () => {
    resendAnswers(403, JSON.stringify({ statusCode: 403, name: "restricted_api_key", message: `Not allowed to send to ${to}` }));
    const { err, logged } = await failedSend();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Resend error 403: /);
    expect(logged).toEqual(["[email] Resend refused the send: HTTP 403 (restricted_api_key)"]);
    expect(logged.join("\n")).not.toContain(to);
  });

  it("logs the status alone when the body carries no error code", async () => {
    resendAnswers(500, "upstream exploded");
    const { logged } = await failedSend();
    expect(logged).toEqual(["[email] Resend refused the send: HTTP 500"]);
  });

  it("logs nothing when the send succeeds", async () => {
    resendAnswers(200, JSON.stringify({ id: "email-id" }));
    const { err, logged } = await failedSend();
    expect(err).toBeNull();
    expect(logged).toEqual([]);
  });
});
