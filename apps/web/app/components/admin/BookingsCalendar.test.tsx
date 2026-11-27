/** The bookings calendar renders a walk-in, whose start_time is the shop's
 *  own clock reading ("09:30") rather than an instant, without crashing. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { BookingsCalendar, daySummary } from "./BookingsCalendar";
import type { Booking } from "~/routes/admin.bookings";
import { ukToday } from "~/lib/dateFormat";

function booking(overrides: Partial<Booking>): Booking {
  return {
    id: "b1",
    booking_date: ukToday(),
    start_time: "09:30",
    end_time: "10:00",
    status: "confirmed",
    customer_name: "Walk-in Wendy",
    service_name: "Skin fade",
    staff_name: "Sam",
    duration_min: 30,
    amount_pence: 2500,
    ...overrides,
  } as Booking;
}

describe("BookingsCalendar", () => {
  it("server-renders today's walk-in at its wall-clock time", () => {
    const html = renderToString(createElement(BookingsCalendar, { bookings: [booking({})], onSelectBooking: () => {} }));
    expect(html).toContain("Walk-in Wendy");
    expect(html).toContain("9:30am");
  });

  it("says a day's bookings in words, not only as coloured dots", () => {
    expect(daySummary([])).toBe("No bookings");
    expect(daySummary([{ status: "confirmed" }, { status: "confirmed" }, { status: "no_show" }])).toBe(
      "3 bookings: 2 confirmed, 1 no show",
    );
    const html = renderToString(createElement(BookingsCalendar, { bookings: [booking({})], onSelectBooking: () => {} }));
    expect(html).toContain("1 booking: 1 confirmed");
    expect(html).not.toContain("bg-blue");
  });

  it("never shows a month outside the loaded days as an empty month", () => {
    // Today's month is only partly loaded: the calendar must say so and offer to load it.
    const today = ukToday();
    const html = renderToString(
      createElement(BookingsCalendar, {
        bookings: [],
        onSelectBooking: () => {},
        loadedFrom: today,
        loadedTo: today,
        onLoadMonth: () => {},
      }),
    );
    expect(html).toContain("are loaded, so part of");
    expect(html).toContain("Load all of");
    expect(html).toContain("Bookings not loaded");
  });
});
