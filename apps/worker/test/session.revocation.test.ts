import { beforeAll, describe, expect, it } from "vitest";
import { authHeaders, bareTokenFor, seedShop, seedUser, tokenFor } from "./helpers";
import { dispatch } from "./request";

let shopId: string;
let userId: string;

beforeAll(async () => {
  shopId = await seedShop("Revocation Shop");
  userId = await seedUser("admin", shopId);
});

describe("session revocation (T4.1)", () => {
  it("rejects a validly-signed token with no live KV session", async () => {
    const token = await bareTokenFor(userId, "admin", shopId);
    const res = await dispatch("GET", `/api/shops/${shopId}/staff`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a token with a live KV session", async () => {
    const token = await tokenFor(userId, "admin", shopId);
    const res = await dispatch("GET", `/api/shops/${shopId}/staff`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
  });

  it("logout via Authorization header revokes the session", async () => {
    const token = await tokenFor(userId, "admin", shopId);

    const logout = await dispatch("POST", "/auth/logout", { headers: authHeaders(token) });
    expect(logout.status).toBe(200);

    const after = await dispatch("GET", `/api/shops/${shopId}/staff`, {
      headers: authHeaders(token),
    });
    expect(after.status).toBe(401);
  });

  it("logout via pp_session cookie revokes the session", async () => {
    const token = await tokenFor(userId, "admin", shopId);

    const logout = await dispatch("POST", "/auth/logout", {
      headers: { Cookie: `pp_session=${encodeURIComponent(token)}` },
    });
    expect(logout.status).toBe(200);

    const after = await dispatch("GET", `/api/shops/${shopId}/staff`, {
      headers: { Cookie: `pp_session=${encodeURIComponent(token)}` },
    });
    expect(after.status).toBe(401);
  });
});
