import { describe, expect, it } from "vitest";
import { isRetailCategory, shopNameInitials } from "./shopLabels";

describe("retail category", () => {
  it("is decided by the owner's category, never by service-name keywords", () => {
    expect(isRetailCategory("Products")).toBe(true);
    expect(isRetailCategory(" retail ")).toBe(true);
    expect(isRetailCategory("Beard & shave")).toBe(false);
    expect(isRetailCategory("Waxing")).toBe(false);
    expect(isRetailCategory(undefined)).toBe(false);
  });
});

describe("shop monogram initials", () => {
  it("takes the first letters of the first two words", () => {
    expect(shopNameInitials("FerdyM's Barber Shop")).toBe("FB");
    expect(shopNameInitials("Control Cuts")).toBe("CC");
  });
  it("skips symbols, so an ampersand never becomes an initial", () => {
    expect(shopNameInitials("Linden & Lark Hair Studio")).toBe("LL");
    expect(shopNameInitials("& Co")).toBe("CO");
  });
  it("falls back for names without letters", () => {
    expect(shopNameInitials("  ")).toBe("?");
    expect(shopNameInitials("&")).toBe("?");
  });
});
