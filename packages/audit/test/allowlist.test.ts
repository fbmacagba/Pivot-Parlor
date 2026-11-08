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
  it("keeps the Plan 3 fields", () => {
    expect(filterChanges("sale", { status: ["completed", "voided"], customer_name: ["A", "B"] })).toEqual({
      status: ["completed", "voided"],
    });
    expect(filterChanges("platform_alert", { resolved: [0, 1], message: ["a", "b"] })).toEqual({ resolved: [0, 1] });
    expect(filterChanges("business_day", { status: ["open", "closed"] })).toEqual({ status: ["open", "closed"] });
    expect(filterChanges("shop", { setup_completed: [0, 1], operational_status: ["a", "b"], stripe_connect_onboarded: [0, 1] })).toEqual({
      setup_completed: [0, 1],
      operational_status: ["a", "b"],
      stripe_connect_onboarded: [0, 1],
    });
  });
  it("every new entity type keeps only structured fields", () => {
    expect(filterChanges("staff", { display_name: ["A", "B"], is_active: [1, 0] })).toEqual({ is_active: [1, 0] });
    expect(filterChanges("supplier", { email: ["a@x", "b@x"] })).toBeNull();
  });
});
