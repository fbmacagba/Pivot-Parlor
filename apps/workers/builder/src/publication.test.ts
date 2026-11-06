import { describe, it, expect } from "vitest";
import {
  buildCandidatePayload,
  CANDIDATE_COLUMNS,
  siteWriteTarget,
  type CandidateColumnValues,
  chooseImage,
  filterClaims,
  gateCopy,
  isUnverifiableClaim,
  mergeCatalog,
  mergeGallery,
  scrubSentences,
  servicesJsonNames,
  type CandidateCopy,
} from "./publication";

const NO_FACTS = "";

describe("isUnverifiableClaim", () => {
  it.each([
    "Trusted by 500+ happy clients",
    "Over 2,000 cuts and counting",
    "5-star rated on Google",
    "Rated 4.9/5 by our regulars",
    "Award-winning barbers",
    "The #1 salon in Bristol",
    "The best barber in Deptford",
    "Satisfaction guaranteed",
    "Established in 2009",
    "15 years of experience",
    "As seen in Vogue",
    "Certified colour specialists",
    "Read our reviews",
    "Top-rated stylists",
  ])("flags %s", (claim) => {
    expect(isUnverifiableClaim(claim, NO_FACTS)).toBe(true);
  });

  it.each([
    "Open Tuesday to Saturday",
    "Choose from 3 barbers",
    "Book online, any time",
    "6 services, clearly priced",
    "Based in Deptford",
    "Precise fades and unhurried beard work",
  ])("passes %s", (fact) => {
    expect(isUnverifiableClaim(fact, NO_FACTS)).toBe(false);
  });

  it("allows a claim the owner supplied", () => {
    const owner = "Family run, established in 2009. Kofi is a master barber.";
    expect(isUnverifiableClaim("Established in 2009", owner)).toBe(false);
    expect(isUnverifiableClaim("Cuts by a master barber", owner)).toBe(false);
    // A different year is still invented.
    expect(isUnverifiableClaim("Established in 2004", owner)).toBe(true);
  });
});

describe("filterClaims / scrubSentences", () => {
  it("splits kept and dropped items and skips blanks", () => {
    const r = filterClaims(["Open seven days a week", "", "500+ happy clients", "  "], NO_FACTS);
    expect(r.kept).toEqual(["Open seven days a week"]);
    expect(r.dropped).toEqual(["500+ happy clients"]);
  });

  it("removes only the offending sentence", () => {
    const r = scrubSentences(
      "A neighbourhood barber on Deptford High Street. Voted best in London three years running! Walk in or book ahead.",
      NO_FACTS,
    );
    expect(r.text).toBe("A neighbourhood barber on Deptford High Street. Walk in or book ahead.");
    expect(r.dropped).toHaveLength(1);
  });
});

describe("chooseImage", () => {
  it("keeps the published image when the slot is locked", () => {
    expect(chooseImage({ generated: "new.png", existing: "owner.png", locked: true })).toBe("owner.png");
  });
  it("takes the new image when one was produced", () => {
    expect(chooseImage({ generated: "new.png", existing: "old.png", locked: false })).toBe("new.png");
  });
  it("keeps the published image when generation failed", () => {
    expect(chooseImage({ generated: null, existing: "old.png", locked: false })).toBe("old.png");
    expect(chooseImage({ generated: "  ", existing: "old.png", locked: false })).toBe("old.png");
  });
  it("is null when there was never an image", () => {
    expect(chooseImage({ generated: undefined, existing: null, locked: false })).toBeNull();
  });
});

describe("mergeCatalog", () => {
  const names = ["Skin fade", "Scissor cut", "Beard sculpt"];

  it("fills failed slots from the published row when the service list is unchanged", () => {
    expect(
      mergeCatalog({
        generated: ["a.png", "", "c.png"],
        existing: ["old-a.png", "old-b.png", "old-c.png"],
        serviceNames: names,
        existingServiceNames: ["Skin Fade", "Scissor  cut", "Beard sculpt"],
      }),
    ).toEqual(["a.png", "old-b.png", "c.png"]);
  });

  it("never moves an old photo onto a different service", () => {
    expect(
      mergeCatalog({
        generated: ["a.png", "", ""],
        existing: ["old-a.png", "old-b.png", "old-c.png"],
        serviceNames: ["Skin fade", "Hot towel shave", "Scissor cut"],
        existingServiceNames: names,
      }),
    ).toEqual(["a.png", "", ""]);
  });

  it("returns one slot per current service even when generation returned fewer", () => {
    expect(mergeCatalog({ generated: [], existing: [], serviceNames: names, existingServiceNames: [] })).toEqual([
      "",
      "",
      "",
    ]);
  });
});

describe("mergeGallery", () => {
  it("keeps new photos, fills holes from the published gallery, caps at 3", () => {
    expect(mergeGallery(["g1.png", "", "g3.png", "g4.png"], ["e1.png", "e2.png", "e3.png"])).toEqual([
      "g1.png",
      "e2.png",
      "g3.png",
    ]);
  });
  it("drops empties and duplicates", () => {
    expect(mergeGallery(["", ""], ["", "e2.png"])).toEqual(["e2.png"]);
    expect(mergeGallery(["x.png", "x.png"], [])).toEqual(["x.png"]);
  });
});

describe("servicesJsonNames", () => {
  it("reads names and tolerates junk", () => {
    expect(servicesJsonNames('[{"name":"Skin fade"},{"price":1},{"name":"Kids cut"}]')).toEqual([
      "Skin fade",
      "",
      "Kids cut",
    ]);
    expect(servicesJsonNames("nope")).toEqual([]);
    expect(servicesJsonNames(null)).toEqual([]);
  });
});

describe("gateCopy", () => {
  const base: CandidateCopy = {
    headline: "Rated the best barber in South London",
    tagline: "Sharp fades. 10 years on the high street.",
    about: "Kofi opened the shop to do unhurried, precise work. Over 5,000 happy clients later, we are still here.",
    seo_title: "FerdyM's Barber Shop | Award-winning fades",
    seo_description: "Fades, scissor cuts and hot towel shaves in Deptford.",
    hero_cta: "Book your chair",
    about_title: "Our story",
    trust_signals: ["5-star rated on Google", "Open Tuesday to Saturday"],
    usps: ["Guaranteed satisfaction", "Pick your own barber"],
    services: [{ name: "Skin fade", description: "Tight fade finished with a razor line. Our #1 seller." }],
  };

  const result = gateCopy({
    shopName: "FerdyM's Barber Shop",
    ownerFacts: "Skin fade, Scissor cut. Team: Kofi Asante (skin fades)",
    copy: base,
    researchHeadline: "Precise fades in Deptford",
    researchAbout: "Unused because the text version survives.",
    factSignals: ["Open Tuesday to Saturday", "Choose from 3 barbers", "Book online, any time"],
  });

  it("replaces a claim-bearing headline with research's clean one", () => {
    expect(result.copy.headline).toBe("Precise fades in Deptford");
  });

  it("scrubs only claim sentences from body copy", () => {
    expect(result.copy.tagline).toBe("Sharp fades.");
    expect(result.copy.about).toBe("Kofi opened the shop to do unhurried, precise work.");
    expect(result.copy.services[0]!.description).toBe("Tight fade finished with a razor line.");
  });

  it("falls back to a neutral seo title", () => {
    expect(result.copy.seo_title).toBe("FerdyM's Barber Shop | Book online");
    expect(result.copy.seo_description).toBe("Fades, scissor cuts and hot towel shaves in Deptford.");
  });

  it("refills trust signals from facts and USPs from safe lines, without duplicates", () => {
    expect(result.copy.trust_signals).toEqual([
      "Open Tuesday to Saturday",
      "Choose from 3 barbers",
      "Book online, any time",
    ]);
    expect(result.copy.usps).toEqual(["Pick your own barber", "Every price shown up front", "Pick your own team member"]);
  });

  it("reports every dropped string", () => {
    expect(result.dropped).toEqual(
      expect.arrayContaining([
        "Rated the best barber in South London",
        "5-star rated on Google",
        "Guaranteed satisfaction",
      ]),
    );
  });

  it("falls back to the shop name when no clean headline exists", () => {
    const r = gateCopy({
      shopName: "Linden & Lark",
      ownerFacts: "",
      copy: { ...base, headline: "Award-winning colour" },
      researchHeadline: "Bristol's #1 salon",
      factSignals: [],
    });
    expect(r.copy.headline).toBe("Linden & Lark");
  });

  it("keeps a published-ready about from research when the text pass was all claims", () => {
    const r = gateCopy({
      shopName: "Linden & Lark",
      ownerFacts: "",
      copy: { ...base, about: "Voted Bristol's best salon." },
      researchAbout: "A daylight studio for colour and considered cuts.",
      factSignals: [],
    });
    expect(r.copy.about).toBe("A daylight studio for colour and considered cuts.");
  });
});

describe("siteWriteTarget (owner review, migration 049)", () => {
  it("writes in place only for a draft or a shop with no site row", () => {
    expect(siteWriteTarget(null)).toBe("direct");
    expect(siteWriteTarget(undefined)).toBe("direct");
    expect(siteWriteTarget({ website_status: "draft" })).toBe("direct");
    expect(siteWriteTarget({ website_status: null })).toBe("direct");
    expect(siteWriteTarget({ website_status: " " })).toBe("direct");
  });

  it("holds every other status for review, including one it does not know", () => {
    expect(siteWriteTarget({ website_status: "live" })).toBe("candidate");
    expect(siteWriteTarget({ website_status: "paused" })).toBe("candidate");
    expect(siteWriteTarget({ website_status: "LIVE" })).toBe("candidate");
    expect(siteWriteTarget({ website_status: "archived" })).toBe("candidate");
  });
});

describe("buildCandidatePayload", () => {
  const columns = Object.fromEntries(CANDIDATE_COLUMNS.map((c) => [c, null])) as CandidateColumnValues;

  it("stores every column, the owner palette and the menu, and nothing else", () => {
    const json = buildCandidatePayload({
      columns: { ...columns, headline: "Hi", design_version: 3, extra: "x" } as CandidateColumnValues,
      ownerPalette: { primary: "#111111", accent: "#C9A84C" },
      serviceNames: ["Skin fade", "Beard trim"],
    });
    const p = JSON.parse(json) as { version: number; columns: Record<string, unknown>; owner_palette: unknown; service_names: string[] };
    expect(p.version).toBe(1);
    expect(Object.keys(p.columns)).toEqual([...CANDIDATE_COLUMNS]);
    expect(p.columns.headline).toBe("Hi");
    expect(p.columns.design_version).toBe(3);
    expect(p.columns).not.toHaveProperty("extra");
    expect(p.owner_palette).toEqual({ primary: "#111111", accent: "#C9A84C" });
    expect(p.service_names).toEqual(["Skin fade", "Beard trim"]);
  });

  it("records no owner palette when the job carried none", () => {
    const p = JSON.parse(buildCandidatePayload({ columns, ownerPalette: null, serviceNames: [] })) as { owner_palette: unknown };
    expect(p.owner_palette).toBeNull();
  });
});
