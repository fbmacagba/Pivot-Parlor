/** The shop's calendar and clock (src/lib/shopTime.ts). Workers run in UTC. */
import { describe, expect, it } from "vitest";
import { peakHoursInShopTime, shopMonthStart, shopToday } from "../src/lib/shopTime";

describe("shopToday", () => {
  it("starts the London day at midnight London time, an hour before UTC in summer", () => {
    expect(shopToday("Europe/London", new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(shopToday("Europe/London", new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-01");
  });

  it("matches UTC in winter", () => {
    expect(shopToday("Europe/London", new Date("2026-11-12T23:30:00Z"))).toBe("2026-11-12");
  });

  it("uses the shop's own zone", () => {
    expect(shopToday("America/New_York", new Date("2026-07-02T02:00:00Z"))).toBe("2026-07-01");
  });

  it("falls back to London for a missing or unknown zone", () => {
    const now = new Date("2026-07-01T23:30:00Z");
    expect(shopToday(null, now)).toBe("2026-07-02");
    expect(shopToday("", now)).toBe("2026-07-02");
    expect(shopToday("Not/AZone", now)).toBe("2026-07-02");
  });
});

describe("shopMonthStart", () => {
  it("counts back whole months from the shop's current month", () => {
    const londonFirstOfOctober = new Date("2026-09-30T23:30:00Z");
    expect(shopMonthStart(0, "Europe/London", londonFirstOfOctober)).toBe("2026-10-01");
    expect(shopMonthStart(11, "Europe/London", londonFirstOfOctober)).toBe("2025-11-01");
  });

  it("crosses the new year", () => {
    expect(shopMonthStart(11, "Europe/London", new Date("2026-01-15T12:00:00Z"))).toBe("2025-02-01");
  });
});

describe("peakHoursInShopTime", () => {
  it("moves summer UTC hours to London's, keeps winter's and walk-in clock times, and sums", () => {
    expect(
      peakHoursInShopTime(
        [
          { bucket: "2026-07-01T09", booking_count: 2 }, // 10:00 BST
          { bucket: "2026-11-12T09", booking_count: 1 }, // 09:00 GMT
          { bucket: "wall:09", booking_count: 4 }, // a walk-in's "09:30"
          { bucket: null, booking_count: 7 }, // unreadable start_time: dropped
        ],
        "Europe/London",
      ),
    ).toEqual([
      { hour: 9, booking_count: 5 },
      { hour: 10, booking_count: 2 },
    ]);
  });

  it("is exact across the clock changes, which fall on whole UTC hours", () => {
    expect(
      peakHoursInShopTime(
        [
          { bucket: "2026-03-29T00", booking_count: 1 }, // 00:00 GMT, before the change
          { bucket: "2026-03-29T01", booking_count: 1 }, // 02:00 BST, after it
          { bucket: "2026-10-25T00", booking_count: 1 }, // 01:00 BST
          { bucket: "2026-10-25T01", booking_count: 1 }, // 01:00 GMT
        ],
        "Europe/London",
      ),
    ).toEqual([
      { hour: 0, booking_count: 1 },
      { hour: 1, booking_count: 2 },
      { hour: 2, booking_count: 1 },
    ]);
  });
});
