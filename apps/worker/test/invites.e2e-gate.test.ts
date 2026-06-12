import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { e2eMockAllowed } from "../src/lib/e2e";

const KNOWN_TOKEN = "a".repeat(64);

describe("E2E fixture gating (E2E_FIXTURES unset, as in production)", () => {
  it("the X-E2E-Test-Mock header does NOT mint the fixture invite", async () => {
    const res = await dispatch("GET", `/api/invites/${KNOWN_TOKEN}`, {
      headers: { "X-E2E-Test-Mock": "1" },
    });
    expect(res.status).toBe(404);

    const shops = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM shops WHERE id = 'e2e00000-0000-4000-8000-000000000001'"
    ).first<{ n: number }>();
    expect(shops?.n).toBe(0);

    const invites = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE token = ?")
      .bind(KNOWN_TOKEN)
      .first<{ n: number }>();
    expect(invites?.n).toBe(0);
  });

  it("helper opens only when E2E_FIXTURES === 'true' AND the header is sent", () => {
    expect(e2eMockAllowed({ E2E_FIXTURES: "true" } as never, "1")).toBe(true);
    expect(e2eMockAllowed({ E2E_FIXTURES: "true" } as never, undefined)).toBe(false);
    expect(e2eMockAllowed({ E2E_FIXTURES: "false" } as never, "1")).toBe(false);
    expect(e2eMockAllowed({} as never, "1")).toBe(false);
  });
});
