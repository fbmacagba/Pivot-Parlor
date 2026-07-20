import { describe, it, expect } from "vitest";
import { googleMapsEmbedUrl, googleMapsUrl } from "@repo/utils";

describe("googleMapsEmbedUrl", () => {
  it("builds the output=embed URL with the query encoded", () => {
    expect(googleMapsEmbedUrl("138 Moselle Avenue, N22 6ET, London")).toBe(
      "https://www.google.com/maps?q=138%20Moselle%20Avenue%2C%20N22%206ET%2C%20London&output=embed",
    );
  });
  it("pairs with googleMapsUrl for the matching directions link", () => {
    expect(googleMapsUrl("138 Moselle Avenue, N22 6ET, London")).toBe(
      "https://www.google.com/maps/search/?api=1&query=138%20Moselle%20Avenue%2C%20N22%206ET%2C%20London",
    );
  });
});
