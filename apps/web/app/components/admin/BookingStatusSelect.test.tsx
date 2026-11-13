/** The admin bookings status select says why a change was refused (for
 *  example a cancelled booking whose time another booking now holds) instead
 *  of silently snapping back to the old status. */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

let fetcherData: { ok: boolean; error?: string } | undefined;

vi.mock("@remix-run/react", async () => {
  const react = await import("react");
  return {
    useFetcher: () => ({
      state: "idle",
      data: fetcherData,
      formData: undefined,
      submit: () => undefined,
      Form: (props: Record<string, unknown>) => react.createElement("form", props),
    }),
  };
});

const { BookingStatusSelect } = await import("./BookingStatusSelect");

const OPTIONS = [
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
];

function render(): string {
  return renderToString(createElement(BookingStatusSelect, { bookingId: "b1", status: "cancelled", options: OPTIONS }));
}

describe("BookingStatusSelect", () => {
  it("shows the refusal the server gave", () => {
    fetcherData = { ok: false, error: "Another booking now holds this time, so this booking cannot be reinstated." };
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Another booking now holds this time, so this booking cannot be reinstated.");
  });

  it("shows nothing extra after a change that worked, or before any", () => {
    fetcherData = { ok: true };
    expect(render()).not.toContain('role="alert"');
    fetcherData = undefined;
    expect(render()).not.toContain('role="alert"');
  });

  it("offers every status, with the booking's own selected", () => {
    fetcherData = undefined;
    const html = render();
    expect(html).toContain('name="bookingId" value="b1"');
    expect(html).toMatch(/<option[^>]*value="cancelled"[^>]*selected/);
    expect(html).toContain(">Confirmed</option>");
  });
});
