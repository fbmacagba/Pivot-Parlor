import { describe, expect, it } from "vitest";
import { CURATED_FONTS, CURATED_FONT_NAMES, resolveCuratedFont, curatedFontStack } from "@repo/utils";

/**
 * WS-6 item 5: every family the resolver can return must be one the web
 * self-hosts (apps/web/app/fonts.ts), and legacy/unknown names must fall to
 * the role defaults that match the pre-WS-6 fallback stacks.
 */

describe("resolveCuratedFont", () => {
  it("keeps exact matches, case-insensitively, returning the canonical name", () => {
    expect(resolveCuratedFont("Playfair Display", "heading").family).toBe("Playfair Display");
    expect(resolveCuratedFont("jost", "body").family).toBe("Jost");
    expect(resolveCuratedFont("  SPACE GROTESK  ", "heading").family).toBe("Space Grotesk");
  });

  it("maps unknown names to the role default (legacy fallback appearance)", () => {
    // Pre-WS-6 heading fallback stack ended in Playfair Display / serif.
    expect(resolveCuratedFont("Cinzel", "heading").family).toBe("Playfair Display");
    // Pre-WS-6 body fallback stack ended in DM Sans / sans-serif.
    expect(resolveCuratedFont("Nunito", "body").family).toBe("DM Sans");
    expect(resolveCuratedFont(undefined, "heading").family).toBe("Playfair Display");
    expect(resolveCuratedFont("", "body").family).toBe("DM Sans");
  });

  it("honours the serif/sans style hint for unknown names — sans checked first", () => {
    // "sans-serif".includes("serif") is true; the hint parser must not trip on it.
    expect(resolveCuratedFont("Oswald", "heading", "sans-serif").family).toBe("Montserrat");
    expect(resolveCuratedFont("Cardo", "heading", "serif").family).toBe("Playfair Display");
    expect(resolveCuratedFont("Karla", "body", "sans-serif").family).toBe("DM Sans");
    expect(resolveCuratedFont("Crimson Text", "body", "serif").family).toBe("Lora");
  });

  it("every resolvable family is in the curated (self-hosted) set", () => {
    const inputs = [...CURATED_FONT_NAMES, "Anything Else", "", undefined];
    for (const role of ["heading", "body"] as const) {
      for (const hint of [undefined, "serif", "sans-serif"]) {
        for (const name of inputs) {
          const { family } = resolveCuratedFont(name, role, hint);
          expect(CURATED_FONT_NAMES).toContain(family);
        }
      }
    }
  });
});

describe("curatedFontStack", () => {
  it("builds a serif stack for serif families and sans for sans", () => {
    expect(curatedFontStack("Playfair Display")).toBe('"Playfair Display", Georgia, serif');
    expect(curatedFontStack("DM Sans")).toBe('"DM Sans", system-ui, sans-serif');
  });

  it("the registry covers both kinds and the prod site's live pair", () => {
    // FerdyM's shop (the only prod site) stores Playfair Display + Jost — both
    // MUST stay in the set or the live site's fonts change.
    expect(CURATED_FONTS["Playfair Display"]).toBe("serif");
    expect(CURATED_FONTS["Jost"]).toBe("sans-serif");
    expect(CURATED_FONTS["DM Sans"]).toBe("sans-serif"); // marketing body
  });
});
