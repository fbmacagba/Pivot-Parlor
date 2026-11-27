import { describe, expect, it } from "vitest";
import { refundAmountPence, summariseSales, tenderLabel } from "./salesSummary";

describe("summariseSales", () => {
  it("counts only sales where money was taken, and splits them by tender", () => {
    const summary = summariseSales([
      { total_pence: 2500, tender_type: "cash", status: "completed", refunded_pence: 0 },
      { total_pence: 1200, tender_type: "stripe", status: "refunded", refunded_pence: 1200 },
      { total_pence: 1999, tender_type: "cash", status: "completed", refunded_pence: 500 },
      { total_pence: 9900, tender_type: "stripe", status: "pending", refunded_pence: 0 },
      { total_pence: 4000, tender_type: "cash", status: "voided", refunded_pence: 0 },
    ]);
    expect(summary).toEqual({
      count: 3,
      gross_pence: 5699,
      refunds_pence: 1700,
      net_pence: 3999,
      by_tender: [
        { tender: "cash", count: 2, gross_pence: 4499 },
        { tender: "stripe", count: 1, gross_pence: 1200 },
      ],
    });
  });

  it("gives no refund or net figure when a sale came without its refunded amount", () => {
    const summary = summariseSales([
      { total_pence: 2500, tender_type: "cash", status: "completed", refunded_pence: 0 },
      { total_pence: 1000, tender_type: "cash", status: "completed" },
    ]);
    expect(summary.gross_pence).toBe(3500);
    expect(summary.refunds_pence).toBeNull();
    expect(summary.net_pence).toBeNull();
  });

  it("an empty day is zero sales, with refunds known to be zero", () => {
    expect(summariseSales([])).toEqual({ count: 0, gross_pence: 0, refunds_pence: 0, net_pence: 0, by_tender: [] });
  });
});

describe("tenderLabel", () => {
  it("names the known tenders and humanises the rest", () => {
    expect(tenderLabel("cash")).toBe("Cash");
    expect(tenderLabel("card_external")).toBe("Card machine");
    expect(tenderLabel("gift_card")).toBe("Gift card");
  });
});

describe("refundAmountPence", () => {
  const sale = {
    subtotal_pence: 3000,
    discount_pence: 300,
    refunded_pence: 0,
    items: [
      { id: "a", quantity: 2, line_total_pence: 2000 },
      { id: "b", quantity: 1, line_total_pence: 1000 },
    ],
  };

  it("takes each line's share of the discount off before refunding", () => {
    // Line a: 2000 less its 200 share = 1800 for two, so 900 for one.
    expect(refundAmountPence(sale, [{ sale_item_id: "a", quantity: 1 }])).toBe(900);
    expect(
      refundAmountPence(sale, [
        { sale_item_id: "a", quantity: 2 },
        { sale_item_id: "b", quantity: 1 },
      ]),
    ).toBe(2700);
  });

  it("never exceeds what is left to refund", () => {
    expect(refundAmountPence({ ...sale, refunded_pence: 2500 }, [{ sale_item_id: "a", quantity: 2 }])).toBe(200);
  });

  it("ignores unknown lines and zero quantities", () => {
    expect(
      refundAmountPence(sale, [
        { sale_item_id: "zz", quantity: 1 },
        { sale_item_id: "b", quantity: 0 },
      ]),
    ).toBe(0);
  });
});
