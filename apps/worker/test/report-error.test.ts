import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError } from "../src/services/report-error.js";

describe("reportError (WS-5 observability)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a single structured JSON line via console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError("booking.confirmation_email", new Error("boom"), { shopId: "s1", bookingId: "b1" });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "error",
      scope: "booking.confirmation_email",
      message: "boom",
      shopId: "s1",
      bookingId: "b1",
    });
    expect(parsed.stack).toContain("boom");
  });

  it("handles non-Error throwables without a stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError("reminder.email_send", "resend 503");

    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.message).toBe("resend 503");
    expect(parsed.stack).toBeUndefined();
  });

  it("never throws, so callers stay non-fatal", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportError("scope", undefined)).not.toThrow();
    expect(() => reportError("scope", { circular: true }, {})).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
