import { describe, expect, it } from "vitest";
import { zonedTimeToUtc } from "../src/lib/timezone";

describe("zonedTimeToUtc (T6.6)", () => {
  it("treats Europe/London as UTC in winter (GMT)", () => {
    // 2027-01-04 is GMT (UTC+0): 09:00 local == 09:00 UTC
    expect(zonedTimeToUtc("2027-01-04", "09:00", "Europe/London").toISOString()).toBe(
      "2027-01-04T09:00:00.000Z"
    );
  });

  it("applies BST (+1) in summer", () => {
    // 2027-07-05 is BST (UTC+1): 09:00 local == 08:00 UTC
    expect(zonedTimeToUtc("2027-07-05", "09:00", "Europe/London").toISOString()).toBe(
      "2027-07-05T08:00:00.000Z"
    );
    expect(zonedTimeToUtc("2027-07-05", "17:00", "Europe/London").toISOString()).toBe(
      "2027-07-05T16:00:00.000Z"
    );
  });

  it("handles the spring-forward day (clocks jump at 01:00 GMT -> 02:00 BST)", () => {
    // 2027-03-28: before 01:00 is GMT, after is BST.
    // 09:00 that day is firmly in BST -> 08:00 UTC.
    expect(zonedTimeToUtc("2027-03-28", "09:00", "Europe/London").toISOString()).toBe(
      "2027-03-28T08:00:00.000Z"
    );
  });

  it("handles the autumn fall-back day", () => {
    // 2027-10-31: clocks go back at 02:00 BST -> 01:00 GMT.
    // 09:00 that day is GMT -> 09:00 UTC.
    expect(zonedTimeToUtc("2027-10-31", "09:00", "Europe/London").toISOString()).toBe(
      "2027-10-31T09:00:00.000Z"
    );
  });

  it("supports other timezones (New York, EDT in July)", () => {
    // 2027-07-05 New York is EDT (UTC-4): 09:00 local == 13:00 UTC
    expect(zonedTimeToUtc("2027-07-05", "09:00", "America/New_York").toISOString()).toBe(
      "2027-07-05T13:00:00.000Z"
    );
  });
});
