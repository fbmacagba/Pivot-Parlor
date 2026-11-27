/** The staff Refunds screen, rendered through a real router with the data
 *  its loader would give: the day's sales, the request form for an opened
 *  sale, and the person's own requests with the owner's decision. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import StaffRefunds from "~/routes/staff.refunds";

const sale = {
  id: "sale-1",
  booking_id: null,
  customer_name: "Jo Bloggs",
  subtotal_pence: 2500,
  discount_pence: 0,
  tip_pence: 0,
  total_pence: 2500,
  tender_type: "cash",
  status: "completed",
  created_at: "2026-11-20T10:15:00.000Z",
  refunded_pence: 0,
};

const request = (over: Record<string, unknown>) => ({
  id: "rr-1",
  kind: "sale",
  booking_id: null,
  sale_id: "sale-9",
  amount_pence: 1200,
  reason: "Clippers stopped working the same day",
  has_evidence: true,
  evidence_name: "photo.jpg",
  status: "pending",
  requested_by: "u-staff",
  requested_by_name: "Sam",
  requested_at: "2026-11-19T09:00:00.000Z",
  reviewed_by_name: null,
  reviewed_at: null,
  review_note: null,
  refunded_pence: null,
  customer_name: null,
  booking_date: null,
  start_time: null,
  sale_created_at: "2026-11-18T12:00:00.000Z",
  sale_tender_type: "cash",
  ...over,
});

const base = {
  shopId: "shop-1",
  developerNeedsShop: false,
  date: "2026-11-20",
  sales: [sale],
  detail: null,
  loadError: false,
  detailError: false,
  pendingRefundSaleIds: [],
  myRequests: [],
  myRequestsError: false,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(data: Record<string, unknown>, path = "/staff/refunds?date=2026-11-20") {
  const Stub = createRoutesStub([{ path: "/staff/refunds", Component: StaffRefunds, loader: () => data }]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Stub initialEntries={[path]} />);
  });
  // The stub's loader settles on a later tick.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("staff Refunds screen", () => {
  it("lists the day's sales, each with a way to ask for a refund that keeps the chosen day", async () => {
    const el = await mount(base);
    expect(el.querySelector("h1")?.textContent).toBe("Refunds");
    const link = el.querySelector<HTMLAnchorElement>('a[href*="sale=sale-1"]')!;
    expect(link.getAttribute("href")).toBe("/staff/refunds?date=2026-11-20&sale=sale-1");
    expect(link.textContent).toContain("Ask for refund");
    expect(el.textContent).toContain("You have not asked for a refund yet");
  });

  it("opens a sale as a request form, with no link to the owner's review page", async () => {
    const detail = {
      ...sale,
      items: [
        { id: "item-1", item_type: "product", name: "Pomade", quantity: 2, returned_quantity: 0, unit_price_pence: 1250, line_total_pence: 2500 },
      ],
      returns: [],
    };
    const el = await mount({ ...base, detail }, "/staff/refunds?date=2026-11-20&sale=sale-1");
    const panel = el.querySelector('section[aria-label="Request a refund on a sale"]')!;
    expect(panel.querySelector('textarea[name="reason"]')).not.toBeNull();
    expect(panel.querySelector('input[type="file"][name="evidence"]')).not.toBeNull();
    expect(panel.textContent).toContain("until the owner approves it");
    expect(panel.querySelector('a[href="/staff/refunds?date=2026-11-20"]')?.textContent).toBe("Close");
    expect(el.querySelector('a[href*="/admin/"]')).toBeNull();
  });

  it("shows no form for a sale that already has a request waiting", async () => {
    const detail = { ...sale, items: [], returns: [] };
    const el = await mount({ ...base, detail, pendingRefundSaleIds: ["sale-1"] }, "/staff/refunds?sale=sale-1");
    const panel = el.querySelector('section[aria-label="Request a refund on a sale"]')!;
    expect(panel.querySelector("form")).toBeNull();
    expect(panel.textContent).toContain("waiting for the owner's decision");
  });

  it("shows each of the person's requests with what the owner decided", async () => {
    const el = await mount({
      ...base,
      myRequests: [
        request({ id: "rr-1" }),
        request({ id: "rr-2", status: "declined", reviewed_by_name: "Alex", reviewed_at: "2026-11-19T15:00:00.000Z", review_note: "No receipt" }),
        request({ id: "rr-3", status: "approved", reviewed_by_name: "Alex", refunded_pence: 1200 }),
      ],
    });
    const rows = Array.from(el.querySelectorAll('section[aria-labelledby="staff-refunds-mine"] li')).map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Waiting for the owner's decision. No money has moved.");
    expect(rows[0]).toContain("evidence attached");
    expect(rows[1]).toContain("Declined by Alex");
    expect(rows[1]).toContain("Owner's note: No receipt");
    expect(rows[2]).toContain("Approved by Alex");
    expect(rows[2]).toContain("£12.00 refunded");
  });
});
