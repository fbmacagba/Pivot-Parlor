/** The pure rules behind the owner pages: which services can be assigned,
 *  which bookings are loaded, which way a stock movement goes, and what counts
 *  as a service duration. */
import { describe, expect, it } from "vitest";
import { assignableServices, isActiveFlag } from "./staffServices";
import {
  BOOKINGS_LIMIT,
  bookingsQuery,
  bookingsWindow,
  matchesBookingSearch,
  monthIsLoaded,
  monthRange,
} from "./bookingsWindow";
import { MOVEMENT_TYPES, signedQuantityDelta } from "./stockMovement";
import { parseDurationMinutes } from "./serviceForm";

describe("assignableServices", () => {
  it("reads the public shape the services list answers in", () => {
    expect(
      assignableServices([
        { id: "s1", name: "Skin fade", durationMinutes: 30, price_pence: 2500, isActive: true },
        { id: "s2", name: "Retired", durationMinutes: 30, price_pence: 2500, isActive: false },
      ]),
    ).toEqual([{ id: "s1", name: "Skin fade", durationMinutes: 30, price_pence: 2500 }]);
  });

  it("reads raw database rows as well", () => {
    expect(
      assignableServices([
        { id: "s1", name: "Skin fade", duration_min: 45, price_pence: 3000, is_active: 1 },
        { id: "s2", name: "Retired", duration_min: 45, price_pence: 3000, is_active: 0 },
      ]),
    ).toEqual([{ id: "s1", name: "Skin fade", durationMinutes: 45, price_pence: 3000 }]);
  });

  it("is empty for anything that is not a list", () => {
    expect(assignableServices(null)).toEqual([]);
    expect(assignableServices({ error: "no" })).toEqual([]);
  });

  it("reads the 0 or 1 a staff row carries", () => {
    expect(isActiveFlag(1)).toBe(true);
    expect(isActiveFlag(true)).toBe(true);
    expect(isActiveFlag(0)).toBe(false);
    expect(isActiveFlag(undefined)).toBe(false);
  });
});

describe("bookingsWindow", () => {
  const today = "2026-11-27";

  it("defaults to 30 days back and 90 days ahead", () => {
    expect(bookingsWindow(null, null, today)).toEqual({ from: "2026-10-28", to: "2027-02-25", isDefault: true });
    expect(bookingsWindow("", "", today).isDefault).toBe(true);
  });

  it("uses both dates when both are chosen, the right way round", () => {
    expect(bookingsWindow("2026-01-01", "2026-01-31", today)).toEqual({ from: "2026-01-01", to: "2026-01-31", isDefault: false });
    expect(bookingsWindow("2026-01-31", "2026-01-01", today)).toEqual({ from: "2026-01-01", to: "2026-01-31", isDefault: false });
  });

  it("bounds a one-sided choice instead of asking for everything", () => {
    expect(bookingsWindow("2026-01-01", null, today)).toEqual({ from: "2026-01-01", to: "2026-05-01", isDefault: false });
    expect(bookingsWindow(null, "2026-05-01", today)).toEqual({ from: "2026-01-01", to: "2026-05-01", isDefault: false });
  });

  it("ignores a value that is not a real day", () => {
    expect(bookingsWindow("2026-02-31", "nonsense", today).isDefault).toBe(true);
  });

  it("always sends the dates and the limit", () => {
    const window = bookingsWindow(null, null, today);
    expect(bookingsQuery(window, "")).toBe(`?date_from=2026-10-28&date_to=2027-02-25&limit=${BOOKINGS_LIMIT}`);
    expect(bookingsQuery(window, "pending")).toContain("status=pending");
  });

  it("knows whether a calendar month is inside the loaded days", () => {
    const window = { from: "2026-10-28", to: "2027-02-25" };
    expect(monthRange(2027, 1)).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(monthRange(2028, 1).to).toBe("2028-02-29");
    expect(monthIsLoaded(2026, 10, window)).toBe(true); // November 2026
    expect(monthIsLoaded(2026, 9, window)).toBe(false); // October starts before the window
    expect(monthIsLoaded(2027, 1, window)).toBe(false); // February ends after it
  });

  it("searches the customer, the service and the staff member", () => {
    const booking = { customer_name: "Wendy Walker", service_name: "Skin fade", staff_name: "Sam" };
    expect(matchesBookingSearch(booking, "")).toBe(true);
    expect(matchesBookingSearch(booking, " wendy ")).toBe(true);
    expect(matchesBookingSearch(booking, "FADE")).toBe(true);
    expect(matchesBookingSearch(booking, "sam")).toBe(true);
    expect(matchesBookingSearch(booking, "beard")).toBe(false);
  });
});

describe("signedQuantityDelta", () => {
  it("removes for waste and adds for a delivery or a return, whatever the form's direction says", () => {
    expect(signedQuantityDelta("waste", "3", "")).toEqual({ ok: true, delta: -3 });
    expect(signedQuantityDelta("waste", "3", "add")).toEqual({ ok: true, delta: -3 });
    expect(signedQuantityDelta("receive", "12", "")).toEqual({ ok: true, delta: 12 });
    expect(signedQuantityDelta("receive", "12", "remove")).toEqual({ ok: true, delta: 12 });
    expect(signedQuantityDelta("return", "1", "")).toEqual({ ok: true, delta: 1 });
  });

  it("asks which way for a correction or a transfer", () => {
    for (const type of ["adjustment", "transfer"]) {
      expect(signedQuantityDelta(type, "2", "add")).toEqual({ ok: true, delta: 2 });
      expect(signedQuantityDelta(type, "2", "remove")).toEqual({ ok: true, delta: -2 });
      expect(signedQuantityDelta(type, "2", "").ok).toBe(false);
    }
  });

  it("takes only a whole number above zero: a typed minus sign is refused, not obeyed", () => {
    for (const quantity of ["", "0", "-3", "1.5", "abc", "3 "]) {
      const result = signedQuantityDelta("receive", quantity, "");
      expect(result.ok, quantity).toBe(quantity === "3 ");
    }
  });

  it("refuses the types the API keeps for the till and the back bar", () => {
    expect(signedQuantityDelta("sale", "1", "").ok).toBe(false);
    expect(signedQuantityDelta("consumption", "1", "").ok).toBe(false);
    // Exactly the worker's MANUAL_TYPES (apps/worker/src/routes/inventory.ts).
    expect(MOVEMENT_TYPES.map((t) => t.value).sort()).toEqual(["adjustment", "receive", "return", "transfer", "waste"]);
  });
});

describe("parseDurationMinutes", () => {
  it("takes a whole number of minutes", () => {
    expect(parseDurationMinutes("30")).toBe(30);
    expect(parseDurationMinutes(" 45 ")).toBe(45);
    expect(parseDurationMinutes("1440")).toBe(1440);
  });

  it("is null for anything else", () => {
    for (const raw of ["", "abc", "0", "-30", "12.5", "30m", "1441", null, undefined]) {
      expect(parseDurationMinutes(raw), String(raw)).toBeNull();
    }
  });
});
