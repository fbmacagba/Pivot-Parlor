/** A send Resend refuses logs its HTTP status and Resend's error code, so a
 *  broken key reads as "HTTP 401 (invalid_api_key)" in the Workers logs
 *  rather than a bare "failed". Resend's message can echo the recipient, so
 *  it never reaches the log. Every credential is generated at runtime. */
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { EmailSendError, sendVerificationEmail } from "../src/services/email";

afterEach(() => {
  vi.restoreAllMocks();
});

const to = `failing-${crypto.randomUUID()}@resend-log.test`;
const key = () => `resend-${crypto.randomUUID()}`;

function resendAnswers(status: number, body: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));
}

function lines(spy: MockInstance): string[] {
  return spy.mock.calls.map((args) => args.map(String).join(" "));
}

async function failedSend(): Promise<{ err: unknown; logged: string[] }> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const err = await sendVerificationEmail(key(), { to, name: null, verifyUrl: "https://verify.test/v" }).then(
    () => null,
    (e: unknown) => e,
  );
  return { err, logged: lines(errors) };
}

describe("a send Resend refuses", () => {
  it("logs the HTTP status and Resend's error code, never its message", async () => {
    resendAnswers(401, JSON.stringify({ statusCode: 401, name: "invalid_api_key", message: `API key is invalid for ${to}` }));
    const { err, logged } = await failedSend();
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).status).toBe(401);
    expect(logged).toEqual(["[email] Resend refused the send: HTTP 401 (invalid_api_key)"]);
    expect(logged.join("\n")).not.toContain(to);
  });

  it("logs the status alone when the body carries no error code", async () => {
    resendAnswers(502, "<html>Bad gateway</html>");
    const { err, logged } = await failedSend();
    expect((err as EmailSendError).status).toBe(502);
    expect(logged).toEqual(["[email] Resend refused the send: HTTP 502"]);
  });

  it("logs no code that is not a plain identifier", async () => {
    resendAnswers(422, JSON.stringify({ name: `invalid for ${to}`, message: "x" }));
    const { logged } = await failedSend();
    expect(logged).toEqual(["[email] Resend refused the send: HTTP 422"]);
  });

  it("logs nothing when the send succeeds", async () => {
    resendAnswers(200, JSON.stringify({ id: "email-id" }));
    const { err, logged } = await failedSend();
    expect(err).toBeNull();
    expect(logged).toEqual([]);
  });
});
