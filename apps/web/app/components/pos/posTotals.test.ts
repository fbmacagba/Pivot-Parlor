import { describe, expect, it } from "vitest";
import { posTotals } from "./posTotals";

// The API's arithmetic (apps/workers/booking/src/routes/sales.ts):
// baseTotalPence = subtotalPence - discountPence + tipPence, all whole pence.
describe("posTotals", () => {
  it("is the subtotal when discount and tip are empty", () => {
    expect(posTotals(4500, "", "")).toEqual({ discountPence: 0, tipPence: 0, totalPence: 4500 });
  });

  it("takes the discount off and adds the tip, in whole pence", () => {
    const t = posTotals(4500, "5", "2.50");
    expect(t.discountPence).toBe(500);
    expect(t.tipPence).toBe(250);
    expect(t.totalPence).toBe(4250);
  });

  it("never rounds through floating point", () => {
    // 0.1 + 0.2 pounds must be 30 pence, not 30.000000000000004.
    expect(posTotals(1000, "0.10", "0.20").totalPence).toBe(1010);
    expect(posTotals(1999, "19.99", "0.01").totalPence).toBe(1);
  });

  it("lets a discount take the whole subtotal, and a tip still counts", () => {
    expect(posTotals(1200, "12.00", "").totalPence).toBe(0);
    expect(posTotals(1200, "12.00", "3").totalPence).toBe(300);
  });

  it("refuses a discount above the subtotal, as the API does, and shows no total", () => {
    const t = posTotals(1200, "12.01", "");
    expect(t.totalPence).toBeNull();
    expect(t.discountError).toBe("The discount cannot be more than the subtotal.");
    expect(t.tipError).toBeUndefined();
  });

  it("shows no total while a field is not an amount, and says which", () => {
    const badTip = posTotals(1200, "", "two");
    expect(badTip.totalPence).toBeNull();
    expect(badTip.tipError).toBeDefined();
    expect(badTip.discountError).toBeUndefined();

    const badDiscount = posTotals(1200, "-1", "");
    expect(badDiscount.totalPence).toBeNull();
    expect(badDiscount.discountError).toBeDefined();

    expect(posTotals(1200, "1.005", "").totalPence).toBeNull();
  });

  it("reads the fields as the page's action does", () => {
    expect(posTotals(1200, " 2.5 ", "£1").totalPence).toBe(1050);
  });
});
