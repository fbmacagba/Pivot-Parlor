/** Self-tests for the shared audit helpers: they must fail closed, or every
 *  later "no personal data" / "no gap row" assertion could pass vacuously. */
import { describe, expect, it } from "vitest";
import { expectNoPersonalData, gapRowsFor } from "./audit-helpers";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  changes_json: null,
  details_json: JSON.stringify({ fields: ["display_name"] }),
  reason: null,
  entity_id: "staff-1",
  shop_id: "shop-1",
  ...over,
});

describe("expectNoPersonalData", () => {
  it("passes a full row that carries none of the values", () => {
    expect(() => expectNoPersonalData(row(), ["Jane Doe", "jane@test.local"])).not.toThrow();
  });

  it("throws on a row that carries an uppercased copy of a value", () => {
    const leaky = row({ details_json: JSON.stringify({ name: "JANE DOE" }) });
    expect(() => expectNoPersonalData(leaky, ["Jane Doe"])).toThrow();
  });

  it("throws on a value that only matches once trimmed", () => {
    const leaky = row({ reason: "jane@test.local" });
    expect(() => expectNoPersonalData(leaky, ["  jane@test.local  "])).toThrow();
  });

  it("throws on a row missing a column", () => {
    const partial = row();
    delete partial.reason;
    expect(() => expectNoPersonalData(partial, ["Jane Doe"])).toThrow();
  });

  it("throws on a row whose shop_id carries a value", () => {
    const leaky = row({ shop_id: "John-Smith-07700900123" });
    expect(() => expectNoPersonalData(leaky, ["John-Smith-07700900123"])).toThrow();
  });

  it("throws on a row missing shop_id", () => {
    const partial = row();
    delete partial.shop_id;
    expect(() => expectNoPersonalData(partial, ["Jane Doe"])).toThrow();
  });

  it("throws when there is no non-empty value to look for", () => {
    expect(() => expectNoPersonalData(row(), [])).toThrow();
    expect(() => expectNoPersonalData(row(), ["", "   "])).toThrow();
  });
});

describe("gapRowsFor", () => {
  it("fails without a request id instead of counting nothing", async () => {
    await expect(gapRowsFor("")).rejects.toThrow();
    await expect(gapRowsFor(null as unknown as string)).rejects.toThrow();
  });
});
