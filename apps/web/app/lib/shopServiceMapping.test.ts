/** Guards the POSITIONAL catalog-image mapping used by the public shop site.
 *  catalog[index] is service[index]'s image; a missing/failed image ("" or
 *  absent) must fall through to an imageless card, NEVER repeat an earlier
 *  service's photo (the old `catalog[index % length]` behaviour, which shifts
 *  the wrong style onto the wrong service once images are service-specific). */
import { describe, it, expect, vi } from "vitest";

// The mappers live in a route module; stub the Remix router import so pulling
// them in doesn't load the real router (the mappers themselves are pure).
vi.mock("@remix-run/react", () => ({ Outlet: () => null }));

import {
  normalizeCommercialServices,
  mapApiServicesToCommercial,
} from "~/routes/$shopSlug";

const apiRow = (id: string, name: string) => ({
  id,
  name,
  durationMinutes: 30,
  price_pence: 2500,
  category: "Hair",
});

describe("catalog images map positionally to services", () => {
  it("normalizeCommercialServices: catalog[i] -> service[i]", () => {
    const out = normalizeCommercialServices(
      [{ name: "Haircut" }, { name: "Beard Trim" }, { name: "Hot Towel Shave" }],
      ["a.png", "b.png", "c.png"]
    );
    expect(out.map((s) => s.image_url)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("normalizeCommercialServices: a hole ('') renders that service imageless, not shifted", () => {
    const out = normalizeCommercialServices(
      [{ name: "Haircut" }, { name: "Beard Trim" }, { name: "Hot Towel Shave" }],
      ["a.png", "", "c.png"]
    );
    // Middle service stays imageless; neighbours keep their own photo.
    expect(out.map((s) => s.image_url)).toEqual(["a.png", "", "c.png"]);
  });

  it("normalizeCommercialServices: fewer images than services -> extras imageless (never a modulo repeat)", () => {
    const out = normalizeCommercialServices(
      [{ name: "s0" }, { name: "s1" }, { name: "s2" }, { name: "s3" }],
      ["a.png", "b.png"]
    );
    // Positional: only s0/s1 imaged. Modulo would wrongly give s2="a", s3="b".
    expect(out.map((s) => s.image_url)).toEqual(["a.png", "b.png", "", ""]);
  });

  it("normalizeCommercialServices: an explicit raw.image_url overrides the catalog slot", () => {
    const out = normalizeCommercialServices(
      [{ name: "s0", image_url: "own.png" }, { name: "s1" }],
      ["a.png", "b.png"]
    );
    expect(out.map((s) => s.image_url)).toEqual(["own.png", "b.png"]);
  });

  it("mapApiServicesToCommercial: catalog[i] -> service[i]", () => {
    const out = mapApiServicesToCommercial(
      [apiRow("1", "Haircut"), apiRow("2", "Beard Trim"), apiRow("3", "Shave")],
      ["a.png", "b.png", "c.png"]
    );
    expect(out.map((s) => s.image_url)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("mapApiServicesToCommercial: fewer images than services -> extras imageless (never a modulo repeat)", () => {
    const out = mapApiServicesToCommercial(
      [apiRow("1", "s0"), apiRow("2", "s1"), apiRow("3", "s2")],
      ["a.png"]
    );
    // Positional: only s0 imaged. Modulo would wrongly give s1="a", s2="a".
    expect(out.map((s) => s.image_url)).toEqual(["a.png", "", ""]);
  });

  it("mapApiServicesToCommercial: empty catalog -> all imageless (no crash)", () => {
    const out = mapApiServicesToCommercial([apiRow("1", "s0"), apiRow("2", "s1")], []);
    expect(out.map((s) => s.image_url)).toEqual(["", ""]);
  });
});

describe("mapApiServicesToCommercial image resolution", () => {
  it("prefers a service's own image_url over the positional catalog", () => {
    const rows = [
      { id: "s1", name: "A", durationMinutes: 30, price_pence: 1000, category: "Hair", image_url: "https://x/custom.png" },
      { id: "s2", name: "B", durationMinutes: 30, price_pence: 1000, category: "Hair", image_url: null },
    ];
    const catalog = ["https://x/cat0.png", "https://x/cat1.png"];
    const out = mapApiServicesToCommercial(rows, catalog);
    expect(out[0].image_url).toBe("https://x/custom.png"); // custom wins
    expect(out[1].image_url).toBe("https://x/cat1.png");   // falls back to catalog[index]
  });

  it("falls back to an imageless card when neither is present", () => {
    const rows = [{ id: "s1", name: "A", durationMinutes: 30, price_pence: 1000, category: "Hair", image_url: null }];
    const out = mapApiServicesToCommercial(rows, []);
    expect(out[0].image_url).toBe("");
  });
});
