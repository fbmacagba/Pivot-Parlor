import { describe, it, expect } from "vitest";
import { parseLockedImages, resolveRegeneratedImageUrls } from "./lockedImages";

describe("parseLockedImages", () => {
  it("reads hero/logo true flags", () => {
    expect(parseLockedImages('{"hero":true}')).toEqual({ hero: true, logo: false });
  });
  it("tolerates null and garbage", () => {
    expect(parseLockedImages(null)).toEqual({});
    expect(parseLockedImages("not json")).toEqual({});
  });
});

describe("resolveRegeneratedImageUrls", () => {
  it("keeps the existing url for a locked slot, takes generated for an unlocked slot", () => {
    const out = resolveRegeneratedImageUrls({
      existingHero: "https://x/old-hero.png",
      existingLogo: "https://x/old-logo.png",
      generatedHero: "https://x/new-hero.png",
      generatedLogo: "https://x/new-logo.png",
      locked: { hero: true, logo: false },
    });
    expect(out).toEqual({ hero: "https://x/old-hero.png", logo: "https://x/new-logo.png" });
  });
  it("with no locks (fresh INSERT path) takes all generated", () => {
    const out = resolveRegeneratedImageUrls({
      existingHero: null,
      existingLogo: null,
      generatedHero: "https://x/new-hero.png",
      generatedLogo: "https://x/new-logo.png",
      locked: {},
    });
    expect(out).toEqual({ hero: "https://x/new-hero.png", logo: "https://x/new-logo.png" });
  });
});
