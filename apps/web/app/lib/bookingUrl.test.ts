import { describe, expect, it } from "vitest";
import { restorableDay, restoredStep, skipRevalidationForWizardParams, wizardSearch } from "./bookingUrl";

describe("restorableDay", () => {
  const today = "2026-11-06";
  it("keeps today and later, real dates only", () => {
    expect(restorableDay("2026-11-06", today)).toBe("2026-11-06");
    expect(restorableDay("2027-01-15", today)).toBe("2027-01-15");
  });
  it("drops past, malformed and impossible days", () => {
    expect(restorableDay("2026-11-05", today)).toBe("");
    expect(restorableDay("2026-02-30", today)).toBe("");
    expect(restorableDay("6/11/2026", today)).toBe("");
    expect(restorableDay("", today)).toBe("");
    expect(restorableDay(null, today)).toBe("");
  });
});

describe("restoredStep", () => {
  it("opens as far as the choices allow when the URL names no step", () => {
    expect(restoredStep({ stepParam: null, hasService: false, hasStaff: false })).toBe(0);
    expect(restoredStep({ stepParam: null, hasService: true, hasStaff: false })).toBe(1);
    expect(restoredStep({ stepParam: null, hasService: true, hasStaff: true })).toBe(2);
  });
  it("honours an earlier step and never skips ahead of the choices", () => {
    expect(restoredStep({ stepParam: "0", hasService: true, hasStaff: true })).toBe(0);
    expect(restoredStep({ stepParam: "2", hasService: true, hasStaff: false })).toBe(1);
    expect(restoredStep({ stepParam: "2", hasService: false, hasStaff: false })).toBe(0);
  });
  it("never restores past date and time: the time is picked again", () => {
    expect(restoredStep({ stepParam: "4", hasService: true, hasStaff: true })).toBe(2);
    expect(restoredStep({ stepParam: "-3", hasService: true, hasStaff: true })).toBe(0);
    expect(restoredStep({ stepParam: "two", hasService: true, hasStaff: true })).toBe(2);
  });
});

describe("wizardSearch", () => {
  it("records only the choices, keeps unrelated params, and caps the step", () => {
    const next = wizardSearch(new URLSearchParams("payment=cancelled&booking=b1"), {
      step: 3,
      serviceId: "svc-1",
      staffId: "any",
      day: "2026-11-10",
    });
    expect(Object.fromEntries(next)).toEqual({
      payment: "cancelled",
      booking: "b1",
      serviceId: "svc-1",
      staffId: "any",
      day: "2026-11-10",
      step: "2",
    });
  });
  it("drops later choices when an earlier one is cleared", () => {
    const next = wizardSearch(new URLSearchParams("serviceId=a&staffId=b&day=2026-11-10&step=2"), {
      step: 0,
      serviceId: "",
      staffId: "b",
      day: "2026-11-10",
    });
    expect(Object.fromEntries(next)).toEqual({ step: "0" });
  });
});

describe("skipRevalidationForWizardParams", () => {
  const run = (from: string, to: string, extra: Record<string, unknown> = {}) =>
    skipRevalidationForWizardParams({
      currentUrl: new URL(`https://web.test${from}`),
      nextUrl: new URL(`https://web.test${to}`),
      defaultShouldRevalidate: true,
      ...extra,
    } as never);

  it("does not reload data when only the wizard's choices change", () => {
    expect(run("/shop/book", "/shop/book?serviceId=a&step=1")).toBe(false);
    expect(run("/shop/book?serviceId=a&step=1", "/shop/book?serviceId=a&staffId=b&day=2026-11-10&step=2")).toBe(false);
  });
  it("reloads as usual for anything else", () => {
    expect(run("/shop/book", "/shop/book?date=2026-11-10&service_id=a")).toBe(true);
    expect(run("/shop/book", "/shop")).toBe(true);
    expect(run("/shop/book?step=1", "/shop/book?step=2", { formMethod: "POST" })).toBe(true);
  });
});
