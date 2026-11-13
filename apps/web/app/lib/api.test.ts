import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorStatus, createApiClient } from "~/lib/api";

function answer(status: number, body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createApiClient, when the API refuses a request", () => {
  it("throws the API's message and carries its status", async () => {
    answer(400, { success: false, error: "full_name is too long (120 characters at most)" });
    const thrown = await createApiClient("https://api.test")
      .post("/api/contact", {})
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("full_name is too long (120 characters at most)");
    expect(apiErrorStatus(thrown)).toBe(400);
  });

  // Website error alerts are grouped by the error's name; a new name would
  // open new groups for every API failure a loader or action rethrows.
  it("keeps the name Error", async () => {
    answer(500, { success: false, error: "Internal error" });
    const thrown = await createApiClient("https://api.test")
      .get("/api/shops")
      .catch((e: unknown) => e);
    expect((thrown as Error).name).toBe("Error");
    expect(apiErrorStatus(thrown)).toBe(500);
  });

  it("has no status for an error that did not come from an API answer", () => {
    expect(apiErrorStatus(new Error("network down"))).toBeUndefined();
    expect(apiErrorStatus("a string")).toBeUndefined();
    expect(apiErrorStatus(null)).toBeUndefined();
  });

  it("still unwraps a successful answer (control)", async () => {
    answer(200, { success: true, data: { id: "s-1" } });
    expect(await createApiClient("https://api.test").get("/api/shops/s-1")).toEqual({ id: "s-1" });
  });
});
