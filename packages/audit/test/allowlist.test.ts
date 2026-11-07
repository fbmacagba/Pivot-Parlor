import { describe, expect, it } from "vitest";
import { filterChanges } from "../src/allowlist";

describe("filterChanges", () => {
  it("keeps only allow-listed fields", () => {
    expect(filterChanges("shop_site", { website_status: ["live", "paused"], secret: ["a", "b"] })).toEqual({
      website_status: ["live", "paused"],
    });
  });
  it("drops everything for an unknown entity type", () => {
    expect(filterChanges("mystery", { a: [1, 2] })).toBeNull();
  });
  it("returns null when nothing survives", () => {
    expect(filterChanges("shop_site", { password: ["x", "y"] })).toBeNull();
  });
});
