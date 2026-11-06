import { describe, expect, it } from "vitest";
import { demoSlots, openingWindow, weekdayName, zonedTimeToUtc } from "./demoBooking";

const services = [{ id: "svc", durationMinutes: 45 }];
const staff = [{ id: "a" }, { id: "b" }];
const hours = JSON.stringify({ mon: "", tue: "09:00-18:00", sat: "Closed", sun: "10:00-16:00" });
const NOW = new Date("2099-06-01T08:00:00Z");

describe("openingWindow", () => {
  it("reads open, closed and unknown days", () => {
    expect(openingWindow(hours, "2099-06-16")).toEqual({ open: 540, close: 1080 }); // Tuesday
    expect(openingWindow(hours, "2099-06-15")).toBeNull(); // Monday ""
    expect(openingWindow(hours, "2099-06-20")).toBeNull(); // Saturday "Closed"
    expect(openingWindow(undefined, "2099-06-16")).toBeUndefined();
    expect(openingWindow("not json", "2099-06-16")).toBeUndefined();
    expect(openingWindow(hours, "2099-02-31")).toBeUndefined();
  });
  it("names the weekday", () => {
    expect(weekdayName("2099-06-15")).toBe("Monday");
  });
});

describe("zonedTimeToUtc", () => {
  it("handles summer and winter time in London", () => {
    expect(zonedTimeToUtc("2099-07-01", 9 * 60, "Europe/London").toISOString()).toBe("2099-07-01T08:00:00.000Z");
    expect(zonedTimeToUtc("2099-01-05", 9 * 60, "Europe/London").toISOString()).toBe("2099-01-05T09:00:00.000Z");
  });
});

describe("demoSlots", () => {
  const base = { serviceId: "svc", staffId: "any", services, staff, hoursJson: hours, timeZone: "Europe/London", now: NOW };

  it("offers times only inside opening hours, leaving room for the service", () => {
    const slots = demoSlots({ ...base, date: "2099-06-16" });
    expect(slots.length).toBeGreaterThan(4);
    const local = slots.map((s) =>
      new Date(s.start_time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }),
    );
    expect(local.every((t) => t >= "09:00" && t <= "17:15")).toBe(true);
    expect(slots.every((s) => s.staff_id === "a" && s.is_available)).toBe(true);
  });

  it("is deterministic, so the sample diary does not shuffle between loads", () => {
    expect(demoSlots({ ...base, date: "2099-06-16" })).toEqual(demoSlots({ ...base, date: "2099-06-16" }));
  });

  it("returns nothing on a closed day, a past day or for ids this page did not load", () => {
    expect(demoSlots({ ...base, date: "2099-06-15" })).toEqual([]);
    expect(demoSlots({ ...base, date: "2099-05-01" })).toEqual([]);
    expect(demoSlots({ ...base, date: "2099-06-16", serviceId: "other-shops-service" })).toEqual([]);
    expect(demoSlots({ ...base, date: "2099-06-16", staffId: "other-shops-staff" })).toEqual([]);
  });

  it("uses a neutral day when the shop has no published hours", () => {
    expect(demoSlots({ ...base, hoursJson: undefined, date: "2099-06-15" }).length).toBeGreaterThan(0);
  });
});
