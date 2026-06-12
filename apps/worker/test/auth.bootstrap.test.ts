import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";

describe("developer account bootstrap removal", () => {
  it("login as dev@pivotparlor.com does NOT create an account when none exists", async () => {
    const res = await dispatch("POST", "/auth/login", {
      body: { email: "dev@pivotparlor.com", password: "attacker-chosen-password" },
    });
    expect(res.status).toBe(401);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM platform_users WHERE email = 'dev@pivotparlor.com'"
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("login with an unknown email returns 401 with the standard envelope", async () => {
    const res = await dispatch("POST", "/auth/login", {
      body: { email: "nobody@example.com", password: "whatever" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid credentials");
  });
});
