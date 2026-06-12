import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

function attemptLogin(email: string, ip = "203.0.113.7") {
  return dispatch("POST", "/auth/login", {
    headers: { "CF-Connecting-IP": ip },
    body: { email, password: "wrong-password" },
  });
}

describe("login rate limiting (T4.4)", () => {
  it("returns 429 with Retry-After after 5 attempts for the same email+IP", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await attemptLogin("victim@test.local");
      expect(res.status).toBe(401);
    }
    const sixth = await attemptLogin("victim@test.local");
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
    const body = (await sixth.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
  });

  it("does not throttle a different email from the same IP within the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await attemptLogin("alice@test.local", "198.51.100.4");
    }
    const other = await attemptLogin("bob@test.local", "198.51.100.4");
    expect(other.status).toBe(401); // wrong password, but not rate limited
  });
});
