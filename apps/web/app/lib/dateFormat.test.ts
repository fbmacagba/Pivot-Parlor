import { afterAll, describe, expect, it, vi } from "vitest";

// Run as a browser far from London would: if a function below used the
// machine's zone, its London answers would come out as Tokyo's. The first
// test proves the switch took effect.
vi.stubEnv("TZ", "Asia/Tokyo");
afterAll(() => {
  vi.unstubAllEnvs();
});

const { formatCount, formatDate, formatDateTime, formatDay, formatTime, toInstant, ukParts, ukToday } = await import(
  "./dateFormat"
);

describe("control: this file runs in Tokyo time", () => {
  it("reads local time as Tokyo's, so a London answer below cannot come from the machine", () => {
    expect(new Date("2026-07-01T14:30:00Z").getHours()).toBe(23);
  });
});

describe("toInstant", () => {
  it("reads SQLite's datetime('now') shape, which has no offset, as the UTC it is written in", () => {
    for (const value of [
      "2026-07-01 14:30:00",
      "2026-07-01T14:30:00",
      "2026-07-01 14:30:00.123",
      "2026-07-01T14:30:00Z",
      "2026-07-01T15:30:00+01:00",
    ]) {
      expect(toInstant(value).toISOString().slice(0, 16), value).toBe("2026-07-01T14:30");
    }
  });

  it("keeps a date-only value as that day, and passes numbers and dates through", () => {
    expect(toInstant("2026-07-01").toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(toInstant(Date.UTC(2026, 6, 1, 14, 30)).toISOString()).toBe("2026-07-01T14:30:00.000Z");
    const d = new Date("2026-07-01T14:30:00Z");
    expect(toInstant(d).getTime()).toBe(d.getTime());
  });

  it("gives an invalid date for nonsense", () => {
    expect(Number.isNaN(toInstant("not a date").getTime())).toBe(true);
  });
});

describe("formatDate, formatTime, formatDateTime", () => {
  // 14:30 UTC on 1 July is 15:30 in London (summer time); 23:30 UTC is 00:30 the next day.
  it("formats in London time, whatever the machine's zone", () => {
    expect(formatTime("2026-07-01 14:30:00", { hour: "2-digit", minute: "2-digit" })).toBe("15:30");
    expect(formatDateTime("2026-07-01T14:30:00Z")).toBe("01/07/2026, 15:30:00");
    expect(formatDate("2026-07-01T23:30:00Z")).toBe("02/07/2026");
  });

  it("in winter London is on UTC", () => {
    expect(formatTime("2026-11-12 15:00:00", { hour: "2-digit", minute: "2-digit" })).toBe("15:00");
  });

  it("writes UK English", () => {
    expect(formatDate("2026-11-12T15:00:00Z", { day: "numeric", month: "short", year: "numeric" })).toBe("12 Nov 2026");
  });

  it("lets a page name another zone (a shop's own)", () => {
    expect(formatTime("2026-07-01T14:30:00Z", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })).toBe("14:30");
  });

  it("falls back to London for a zone the browser does not know, instead of throwing and taking the page down", () => {
    expect(formatTime("2026-07-01T14:30:00Z", { hour: "2-digit", minute: "2-digit", timeZone: "Not/AZone" })).toBe("15:30");
    expect(formatTime("2026-07-01T14:30:00Z", { hour: "2-digit", minute: "2-digit", timeZone: "" })).toBe("15:30");
  });

  it("gives an empty string for an invalid value, never 'Invalid Date'", () => {
    expect(formatDate("not a date")).toBe("");
    expect(formatTime("")).toBe("");
    expect(formatDateTime("nope")).toBe("");
  });
});

describe("formatDay", () => {
  it("formats a calendar day as that same day in every zone", () => {
    expect(formatDay("2026-03-29", { day: "numeric", month: "short", year: "numeric" })).toBe("29 Mar 2026");
    expect(formatDay("2026-11-01", { month: "long", year: "numeric" })).toBe("November 2026");
  });

  it("gives the input back when it is not a day", () => {
    expect(formatDay("soon")).toBe("soon");
    expect(formatDay("")).toBe("");
  });
});

describe("ukParts and ukToday", () => {
  it("read the London clock (weekday 0 is Sunday)", () => {
    // 2 July 2026 is a Thursday.
    expect(ukParts("2026-07-01T23:30:00Z")).toEqual({ year: 2026, month: 7, day: 2, hour: 0, minute: 30, weekday: 4 });
    expect(ukToday(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(ukToday(new Date("2026-11-12T15:00:00Z"))).toBe("2026-11-12");
  });
});

describe("formatCount", () => {
  it("groups thousands in UK English", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
  });
});
