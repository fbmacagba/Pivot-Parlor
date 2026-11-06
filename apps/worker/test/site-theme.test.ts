import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  ensureContrast,
  hexToRgb,
  relativeLuminance,
  resolveSiteTheme,
} from "@repo/utils";

/**
 * WS-6 item 3+4: the site theme resolver. Pure functions — the worker suite
 * hosts these tests because @repo/utils has no runner of its own (same
 * arrangement as the WS-4 pence helpers).
 */

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

describe("colour math", () => {
  it("computes WCAG luminance and contrast at the reference points", () => {
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 5);
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 5);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 1);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it("hexToRgb accepts only 6-digit hex", () => {
    expect(hexToRgb("#C9A84C")).toEqual({ r: 201, g: 168, b: 76 });
    expect(hexToRgb("#fff")).toBeNull();
    expect(hexToRgb("red")).toBeNull();
  });

  it("ensureContrast pushes a failing colour until it passes", () => {
    const bg = hexToRgb("#faf6ef")!; // near-white
    const badInk = hexToRgb("#d8d2c6")!; // light grey — unreadable on near-white
    const fixed = ensureContrast(badInk, bg, 4.5);
    expect(contrastRatio(fixed, bg)).toBeGreaterThanOrEqual(4.5);
    // A colour that already passes is returned untouched.
    const goodInk = hexToRgb("#222222")!;
    expect(ensureContrast(goodInk, bg, 4.5)).toEqual(goodInk);
  });
});

describe("resolveSiteTheme — legacy path", () => {
  it("reproduces the pre-token colours exactly when there is no palette", () => {
    const { scheme, vars } = resolveSiteTheme({
      color_primary: "#1a1a1a",
      color_accent: "#d4a853",
    });
    expect(scheme).toBe("dark");
    expect(vars["--st-bg"]).toBe("#1a1a1a");
    expect(vars["--color-brand"]).toBe("#1a1a1a");
    expect(vars["--color-accent"]).toBe("#d4a853");
    expect(vars["--st-ink"]).toBe("#ffffff");
    expect(vars["--st-ink-75"]).toBe("rgba(255, 255, 255, 0.75)");
    expect(vars["--st-line-10"]).toBe("rgba(255, 255, 255, 0.1)");
    expect(vars["--st-card"]).toBe("rgba(255, 255, 255, 0.04)");
    expect(vars["--st-panel-2"]).toBe("rgba(0, 0, 0, 0.2)");
    expect(vars["--st-on-accent"]).toBe("#000000");
    expect(vars["--st-accent-text"]).toBe("#d4a853");
    expect(vars["--st-accent-15"]).toBe("rgba(212, 168, 83, 0.15)");
    expect(vars["--st-bubble"]).toBe("#3f3f46");
    // Item 4 gate: legacy sites keep the stock radii and card hairline.
    expect(vars["--st-r-lg"]).toBe("1rem");
    expect(vars["--st-r-md"]).toBe("0.75rem");
    expect(vars["--st-r-sm"]).toBe("0.5rem");
    expect(vars["--st-line-card"]).toBe("rgba(255, 255, 255, 0.1)");
  });

  it("ignores the palette when design_version is 1", () => {
    const { scheme, vars } = resolveSiteTheme({
      color_primary: "#101010",
      color_accent: "#c9a84c",
      palette: { background: "#ffffff", text: "#111111", accent: "#0a5" },
      design_version: 1,
      shop_id: "shop-1",
    });
    expect(scheme).toBe("dark");
    expect(vars["--st-bg"]).toBe("#101010");
    expect(vars["--st-ink"]).toBe("#ffffff");
    expect(vars["--st-r-lg"]).toBe("1rem");
  });
});

describe("resolveSiteTheme — v2 palette path", () => {
  const lightPalette = {
    primary: "#2f4f4f",
    accent: "#b3572d",
    background: "#faf6ef",
    text: "#26221b",
    muted: "#6f6a5f",
  };

  it("renders a light scheme from a near-white background", () => {
    const { scheme, vars } = resolveSiteTheme({
      color_primary: "#2f4f4f",
      color_accent: "#b3572d",
      palette: lightPalette,
      design_version: 2,
      shop_id: "shop-light",
    });
    expect(scheme).toBe("light");
    expect(vars["--st-bg"]).toBe("#faf6ef");
    expect(vars["--st-ink"]).toBe("#26221b"); // palette text already passes AA
    expect(vars["--st-card"]).toBe("#ffffff");
    expect(vars["--color-brand"]).toBe("#2f4f4f");
    // Ink contrast guard held.
    const ink = hexToRgb(vars["--st-ink"]!)!;
    const bg = hexToRgb(vars["--st-bg"]!)!;
    expect(contrastRatio(ink, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps every text ink step readable (>= 4.5:1) on a light palette", () => {
    // The salon demo's ivory palette: a plain /55 step measured 3.5:1.
    const { vars } = resolveSiteTheme({
      palette: { primary: "#6F7D63", accent: "#2F3A2B", background: "#F6F2EA", text: "#22251F", muted: "#6A6E62" },
      design_version: 3,
      shop_id: "pp-demo-linden-lark",
    });
    const bg = hexToRgb(vars["--st-bg"]!)!;
    const ink = hexToRgb(vars["--st-ink"]!)!;
    for (const step of [40, 45, 50, 55, 60, 70]) {
      const alpha = Number(/,\s*([\d.]+)\)$/.exec(vars[`--st-ink-${step}`]!)![1]);
      expect(alpha).toBeGreaterThanOrEqual(step / 100);
      const shown = {
        r: Math.round(bg.r + (ink.r - bg.r) * alpha),
        g: Math.round(bg.g + (ink.g - bg.g) * alpha),
        b: Math.round(bg.b + (ink.b - bg.b) * alpha),
      };
      expect(contrastRatio(shown, bg)).toBeGreaterThanOrEqual(4.5);
    }
    // Decorative steps below /40 keep their exact opacity.
    expect(vars["--st-ink-30"]).toBe("rgba(34, 37, 31, 0.3)");
  });

  it("leaves a dark palette's ink steps at their exact values when they already pass", () => {
    const { vars } = resolveSiteTheme({
      palette: { primary: "#1F3A2E", accent: "#B8893B", background: "#0F1512", text: "#ECE5D5", muted: "#A39E8F" },
      design_version: 3,
      shop_id: "pp-demo-ferdyms-barber",
    });
    expect(vars["--st-ink-70"]).toBe("rgba(236, 229, 213, 0.7)");
  });

  it("keeps a dark scheme for a dark palette background", () => {
    const { scheme, vars } = resolveSiteTheme({
      palette: { ...lightPalette, background: "#141210", text: "#f2ede4" },
      design_version: 2,
      shop_id: "shop-dark",
    });
    expect(scheme).toBe("dark");
    expect(vars["--st-bg"]).toBe("#141210");
    expect(vars["--st-panel-2"]).toBe("rgba(0, 0, 0, 0.2)");
  });

  it("guards unreadable palette text to >= 4.5:1", () => {
    const { vars } = resolveSiteTheme({
      palette: { background: "#ffffff", text: "#e0e0e0", accent: "#b3572d" }, // grey-on-white fails
      design_version: 2,
      shop_id: "s",
    });
    const ink = hexToRgb(vars["--st-ink"]!)!;
    expect(contrastRatio(ink, hexToRgb("#ffffff")!)).toBeGreaterThanOrEqual(4.5);
  });

  it("guards accent-as-text to >= 3:1 while leaving fills untouched", () => {
    const { vars } = resolveSiteTheme({
      palette: { background: "#ffffff", text: "#111111", accent: "#f5d76e" }, // pale gold fails on white
      design_version: 2,
      shop_id: "s",
    });
    expect(vars["--color-accent"]).toBe("#f5d76e"); // fill keeps brand colour
    const accentText = hexToRgb(vars["--st-accent-text"]!)!;
    expect(contrastRatio(accentText, hexToRgb("#ffffff")!)).toBeGreaterThanOrEqual(3);
  });

  it("picks the on-accent colour by contrast", () => {
    const dark = resolveSiteTheme({
      palette: { background: "#ffffff", text: "#111111", accent: "#f5d76e" },
      design_version: 2,
    });
    expect(dark.vars["--st-on-accent"]).toBe("#000000"); // pale accent → black text
    const light = resolveSiteTheme({
      palette: { background: "#ffffff", text: "#111111", accent: "#5b2333" },
      design_version: 2,
    });
    expect(light.vars["--st-on-accent"]).toBe("#ffffff"); // deep accent → white text
  });

  it("falls back to legacy when the palette background is malformed", () => {
    const { scheme, vars } = resolveSiteTheme({
      color_primary: "#1a1a1a",
      palette: { background: "white", text: "#111111" },
      design_version: 2,
    });
    expect(scheme).toBe("dark");
    expect(vars["--st-bg"]).toBe("#1a1a1a");
  });

  it("derives deterministic per-shop variation from shop_id (item 4)", () => {
    const input = {
      palette: lightPalette,
      design_version: 2,
      shop_id: "b7e3a4c1-0000-4000-8000-000000000001",
    };
    const a = resolveSiteTheme(input);
    const b = resolveSiteTheme({ ...input });
    expect(a.vars["--st-r-lg"]).toBe(b.vars["--st-r-lg"]);
    expect(a.vars["--st-line-card"]).toBe(b.vars["--st-line-card"]);
    // The radius always comes from one of the three coherent scales.
    expect(["0.75rem", "1rem", "1.25rem"]).toContain(a.vars["--st-r-lg"]);
  });
});
