import { describe, expect, it } from "vitest";
import { bookingSpan, countdownLabel, listLimit, pickNextBooking, staffBookingActions } from "./today";

// A winter day, so London is UTC and the clock readings below are the instants.
const DAY = "2026-01-15";
const at = (hhmm: string) => Date.parse(`${DAY}T${hhmm}:00Z`);

const booking = (id: string, start: string, end: string, status = "confirmed") => ({
  id,
  booking_date: DAY,
  start_time: start,
  end_time: end,
  status,
  duration_min: 30,
});

const day = () => [
  booking("nine", "09:00", "09:30"),
  booking("noon", "12:00", "12:30"),
  booking("four", "16:00", "16:30"),
];

describe("pickNextBooking", () => {
  it("in the morning, leads with the first booking still to come", () => {
    const next = pickNextBooking(day(), at("08:15"));
    expect(next?.booking.id).toBe("nine");
    expect(next?.kind).toBe("upcoming");
    expect(next?.startMs).toBe(at("09:00"));
  });

  it("while a booking's time is running, it is due", () => {
    const next = pickNextBooking(day(), at("09:10"));
    expect(next?.booking.id).toBe("nine");
    expect(next?.kind).toBe("due");
  });

  it("by mid-day, a 09:00 booking nobody marked is no longer next", () => {
    const next = pickNextBooking(day(), at("11:00"));
    expect(next?.booking.id).toBe("noon");
    expect(next?.kind).toBe("upcoming");
  });

  it("the booking in progress leads, whatever the clock says", () => {
    const bookings = day();
    bookings[0]!.status = "in_progress";
    const next = pickNextBooking(bookings, at("13:00"));
    expect(next?.booking.id).toBe("nine");
    expect(next?.kind).toBe("in_progress");
  });

  it("at the end of the day, the earliest unfinished booking shows as overdue", () => {
    const bookings = day();
    bookings[0]!.status = "completed";
    const next = pickNextBooking(bookings, at("18:00"));
    expect(next?.booking.id).toBe("noon");
    expect(next?.kind).toBe("overdue");
  });

  it("gives nothing once every booking is finished", () => {
    const done = day().map((b) => ({ ...b, status: "completed" }));
    expect(pickNextBooking(done, at("18:00"))).toBeNull();
    expect(pickNextBooking([], at("09:00"))).toBeNull();
  });

  it("orders by time, not by the order the API sent", () => {
    const next = pickNextBooking(day().reverse(), at("08:00"));
    expect(next?.booking.id).toBe("nine");
  });

  it("reads online bookings (instants) and walk-ins (clock readings) alike", () => {
    const mixed = [
      { ...booking("walk-in", "10:00", "10:30") },
      { ...booking("online", `${DAY}T09:00:00.000Z`, `${DAY}T09:30:00.000Z`) },
    ];
    expect(pickNextBooking(mixed, at("08:00"))?.booking.id).toBe("online");
    expect(pickNextBooking(mixed, at("09:45"))?.booking.id).toBe("walk-in");
  });

  it("claims nothing about the clock for a booking whose time it cannot read", () => {
    const next = pickNextBooking([booking("odd", "soon", "later")], at("09:00"));
    expect(next?.kind).toBe("upcoming");
    expect(next?.startMs).toBeNull();
  });
});

describe("bookingSpan", () => {
  it("uses the service's length when the end cannot be read", () => {
    expect(bookingSpan({ booking_date: DAY, start_time: "09:00", end_time: null, status: "confirmed", duration_min: 45 })).toEqual({
      startMs: at("09:00"),
      endMs: at("09:45"),
    });
  });
});

describe("countdownLabel", () => {
  it("reads in minutes, then hours and minutes, and never 'in 0m'", () => {
    expect(countdownLabel(at("09:00"), at("08:35"))).toBe("in 25m");
    expect(countdownLabel(at("10:05"), at("09:00"))).toBe("in 1h 5m");
    expect(countdownLabel(at("11:00"), at("09:00"))).toBe("in 2h");
    expect(countdownLabel(at("09:00"), at("09:00") - 5_000)).toBe("in 1m");
  });
});

describe("staffBookingActions", () => {
  it("offers start then complete for a booking not yet started", () => {
    expect(staffBookingActions("confirmed", DAY, DAY)).toEqual(["in_progress", "completed"]);
    expect(staffBookingActions("pending", DAY, DAY)).toEqual(["in_progress", "completed"]);
  });

  it("offers only complete once it is in progress", () => {
    expect(staffBookingActions("in_progress", DAY, DAY)).toEqual(["completed"]);
  });

  it("offers nothing for a finished booking or one on a later day", () => {
    expect(staffBookingActions("completed", DAY, DAY)).toEqual([]);
    expect(staffBookingActions("cancelled", DAY, DAY)).toEqual([]);
    expect(staffBookingActions("confirmed", "2026-01-16", DAY)).toEqual([]);
  });

  it("still lets an earlier day's unfinished booking be completed", () => {
    expect(staffBookingActions("confirmed", "2026-01-14", DAY)).toEqual(["in_progress", "completed"]);
  });
});

describe("listLimit", () => {
  it("grows by whole pages and stops at the cap", () => {
    expect(listLimit(null)).toBe(20);
    expect(listLimit("40")).toBe(40);
    expect(listLimit("45")).toBe(60);
    expect(listLimit("5000")).toBe(100);
    expect(listLimit("-3")).toBe(20);
    expect(listLimit("abc")).toBe(20);
  });
});
