import { describe, expect, it } from "vitest";
import { bookingInterval, shiftDate } from "../src/lib/bookingTimes";

const LONDON = "Europe/London";
const iso = (d: { start: Date; end: Date } | null) =>
  d ? [d.start.toISOString(), d.end.toISOString()] : null;

describe("bookingInterval", () => {
  it("reads an online booking's instants as they are", () => {
    const row = { booking_date: "2099-07-15", start_time: "2099-07-15T08:30:00.000Z", end_time: "2099-07-15T09:00:00.000Z" };
    expect(iso(bookingInterval(row, LONDON))).toEqual(["2099-07-15T08:30:00.000Z", "2099-07-15T09:00:00.000Z"]);
  });

  it("reads a clock reading in the shop's zone, summer and winter", () => {
    expect(iso(bookingInterval({ booking_date: "2099-07-15", start_time: "09:30", end_time: "10:00" }, LONDON)))
      .toEqual(["2099-07-15T08:30:00.000Z", "2099-07-15T09:00:00.000Z"]);
    expect(iso(bookingInterval({ booking_date: "2099-01-15", start_time: "09:30", end_time: "10:00" }, LONDON)))
      .toEqual(["2099-01-15T09:30:00.000Z", "2099-01-15T10:00:00.000Z"]);
  });

  it("ends a booking that runs past midnight on the next day", () => {
    expect(iso(bookingInterval({ booking_date: "2099-01-15", start_time: "23:30", end_time: "00:30" }, LONDON)))
      .toEqual(["2099-01-15T23:30:00.000Z", "2099-01-16T00:30:00.000Z"]);
  });

  it("returns null for times it cannot read", () => {
    expect(bookingInterval({ booking_date: "2099-01-15", start_time: "9:30", end_time: "10:00" }, LONDON)).toBeNull();
    expect(bookingInterval({ booking_date: "", start_time: "09:30", end_time: "10:00" }, LONDON)).toBeNull();
    expect(bookingInterval({ booking_date: "2099-01-15", start_time: "2099-01-15Tnope", end_time: "x" }, LONDON)).toBeNull();
  });
});

describe("shiftDate", () => {
  it("crosses month and year ends", () => {
    expect(shiftDate("2099-12-31", 1)).toBe("2100-01-01");
    expect(shiftDate("2099-03-01", -2)).toBe("2099-02-27");
  });
});
