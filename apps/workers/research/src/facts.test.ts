import { describe, it, expect } from "vitest";
import {
  alignServiceCopy,
  factSignals,
  formatFactsBlock,
  normalizeGalleryPrompts,
  openDaysPhrase,
  parseBusiness,
} from "./facts";

const week = (open: string[]) =>
  Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, open.includes(d) ? "9:00-18:00" : "closed"]));

describe("parseBusiness", () => {
  it("returns an empty fact set for messages from an older main worker", () => {
    expect(parseBusiness(undefined)).toEqual({ team: [], categories: [] });
    expect(parseBusiness("junk")).toEqual({ team: [], categories: [] });
  });

  it("keeps valid team members and drops nameless ones", () => {
    const b = parseBusiness({
      locality: "  Deptford, London ",
      team: [{ name: "Kofi Asante", speciality: "Skin fades" }, { speciality: "no name" }, { name: "Dan" }, null],
      categories: ["Cuts", "", 4, "Beard & shave"],
    });
    expect(b.locality).toBe("Deptford, London");
    expect(b.team).toEqual([{ name: "Kofi Asante", speciality: "Skin fades" }, { name: "Dan" }]);
    expect(b.categories).toEqual(["Cuts", "Beard & shave"]);
  });

  it("omits hours when every day is closed", () => {
    expect(parseBusiness({ hours: week([]) }).hours).toBeUndefined();
    expect(parseBusiness({ hours: { sat: "10:00-16:00" } }).hours?.mon).toBe("closed");
  });
});

describe("openDaysPhrase", () => {
  it.each([
    [["tue", "wed", "thu", "fri", "sat"], "Open Tuesday to Saturday"],
    [["mon", "tue", "wed", "thu", "fri", "sat", "sun"], "Open seven days a week"],
    [["mon", "wed", "fri"], "Open 3 days a week"],
    [["sat"], "Open Saturday only"],
  ])("%j -> %s", (open, phrase) => {
    expect(openDaysPhrase(week(open as string[]))).toBe(phrase);
  });

  it("is undefined without hours", () => {
    expect(openDaysPhrase(undefined)).toBeUndefined();
    expect(openDaysPhrase(week([]))).toBeUndefined();
  });
});

describe("factSignals", () => {
  const ferdy = parseBusiness({
    locality: "Deptford, London",
    hours: week(["tue", "wed", "thu", "fri", "sat"]),
    team: [{ name: "Kofi" }, { name: "Dan" }, { name: "Ruby" }],
    categories: ["Cuts"],
  });

  it("states only facts drawn from the records", () => {
    expect(factSignals(ferdy, 6, "barber_shop")).toEqual([
      "Open Tuesday to Saturday",
      "Choose from 3 barbers",
      "Book online, any time",
      "6 services, clearly priced",
      "Based in Deptford, London",
      "No account needed to book",
    ]);
  });

  it("uses the right role noun and skips team/service lines it cannot back", () => {
    const solo = parseBusiness({ team: [{ name: "Isla" }] });
    expect(factSignals(solo, 2, "beauty_parlor")).toEqual(["Book online, any time", "No account needed to book"]);
    const salon = parseBusiness({ team: [{ name: "Isla" }, { name: "Priya" }] });
    expect(factSignals(salon, 0, "beauty_parlor")).toContain("Choose from 2 stylists");
  });

  it("never emits counts of clients, ratings or awards", () => {
    const lines = factSignals(ferdy, 6, "barber_shop").join(" ");
    expect(lines).not.toMatch(/clients|rated|star|award|years/i);
  });
});

describe("formatFactsBlock", () => {
  it("lists area, hours, team with specialities, categories and the service count", () => {
    const block = formatFactsBlock(
      parseBusiness({
        locality: "Clifton, Bristol",
        hours: week(["tue", "sat"]),
        team: [{ name: "Isla Brennan", speciality: "Colour and balayage" }, { name: "Tom Ashby" }],
        categories: ["Colour"],
      }),
      [{ name: "Balayage" }, { name: "Blow-dry" }],
    );
    expect(block).toContain("Area: Clifton, Bristol");
    expect(block).toContain("Tuesday 9:00-18:00");
    expect(block).toContain("Monday closed");
    expect(block).toContain("Team (2): Isla Brennan (Colour and balayage), Tom Ashby");
    expect(block).toContain("Service categories: Colour");
    expect(block).toContain("Number of services on the menu: 2");
  });

  it("states a zero-service menu rather than omitting it", () => {
    expect(formatFactsBlock({ team: [], categories: [] }, [])).toContain("Number of services on the menu: 0");
  });
});

describe("alignServiceCopy", () => {
  it("maps model keys onto real names and ignores invented services", () => {
    const out = alignServiceCopy(
      {
        "beard sculpt and line up": "Shaped with clippers and finished with a straight razor.",
        "Skin Fade": "Faded to the skin.",
        "Platinum VIP package": "Should never appear.",
        "Hot towel shave": "",
      },
      [{ name: "Skin fade" }, { name: "Beard sculpt & line-up" }, { name: "Hot towel shave" }],
    );
    expect(out).toEqual({
      "Skin fade": "Faded to the skin.",
      "Beard sculpt & line-up": "Shaped with clippers and finished with a straight razor.",
    });
  });

  it("tolerates non-object input", () => {
    expect(alignServiceCopy(["a"], [{ name: "a" }])).toEqual({});
    expect(alignServiceCopy(null, [{ name: "a" }])).toEqual({});
  });
});

describe("normalizeGalleryPrompts", () => {
  it("always returns three prompts that exclude people and text", () => {
    const out = normalizeGalleryPrompts(["A warm photograph of the shop's front window at dusk"], "tungsten and brass", "barber_shop");
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^A warm photograph/);
    for (const p of out) expect(p).toMatch(/no text/i);
    expect(out[1]).toContain("barbershop");
  });

  it("ignores short or non-string model prompts", () => {
    const out = normalizeGalleryPrompts(["short", 7, null], "daylight", "beauty_parlor");
    expect(out).toHaveLength(3);
    expect(out.every((p) => p.includes("hair salon"))).toBe(true);
  });
});
