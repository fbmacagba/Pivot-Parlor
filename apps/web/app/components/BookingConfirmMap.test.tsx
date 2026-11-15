import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingConfirmMap } from "./BookingConfirmMap";

describe("BookingConfirmMap", () => {
  it("offers the address map behind consent and links directions in a new tab", () => {
    const html = renderToStaticMarkup(<BookingConfirmMap address="1 High St, London" />);
    // Google's map loads only after the visitor allows it (ConsentedMap).
    expect(html).not.toContain("https://www.google.com/maps?q=");
    expect(html).toContain("Show map");
    expect(html).toContain("https://www.google.com/maps/search/?api=1&amp;query=1%20High%20St%2C%20London");
    expect(html).toContain("Get directions");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
