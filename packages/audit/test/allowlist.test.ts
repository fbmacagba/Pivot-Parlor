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
  it("shop changes never carry name, slug or phone", () => {
    expect(
      filterChanges("shop", { name: ["a", "b"], slug: ["x", "y"], phone: ["1", "2"], commission_rate: [0.1, 0.2] })
    ).toEqual({ commission_rate: [0.1, 0.2] });
  });
  it("every new entity type keeps only structured fields", () => {
    expect(filterChanges("staff", { display_name: ["A", "B"], is_active: [1, 0] })).toEqual({ is_active: [1, 0] });
    expect(filterChanges("supplier", { email: ["a@x", "b@x"] })).toBeNull();
  });
});
