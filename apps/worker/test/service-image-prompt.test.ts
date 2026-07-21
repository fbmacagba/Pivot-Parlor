import { describe, expect, it } from "vitest";
import { catalogSubjectFor, buildServiceImagePrompt } from "@repo/utils";

// This prompt string must stay byte-identical to the research worker's catalog
// template (apps/workers/research/src/index.ts, catalogSubjectFor + coerceSpecCounts,
// PR #104) so a developer single-visual regenerate matches a full-site regenerate.
describe("catalogSubjectFor", () => {
  it("returns a male client for a barber shop", () => {
    expect(catalogSubjectFor("barber_shop")).toBe("a male client");
  });
  it("returns a female client for a beauty parlor", () => {
    expect(catalogSubjectFor("beauty_parlor")).toBe("a female client");
  });
  it("returns a neutral client for both / unknown", () => {
    expect(catalogSubjectFor("both")).toBe("a client");
    expect(catalogSubjectFor("anything_else")).toBe("a client");
  });
});

describe("buildServiceImagePrompt", () => {
  it("builds the exact gendered catalog prompt for a barber service", () => {
    expect(buildServiceImagePrompt("Skin Fade", "barber_shop")).toBe(
      "Photorealistic close-up of the finished Skin Fade result on a male client, flattering professional lighting, square format"
    );
  });
  it("builds the exact gendered catalog prompt for a beauty service", () => {
    expect(buildServiceImagePrompt("Balayage", "beauty_parlor")).toBe(
      "Photorealistic close-up of the finished Balayage result on a female client, flattering professional lighting, square format"
    );
  });
});
