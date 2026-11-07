import { describe, expect, it } from "vitest";
import { bookingLabel, DEFAULT_BOOK_LABEL, isRetailCategory, shopNameInitials } from "./shopLabels";

describe("bookingLabel: one verb and one case per shop", () => {
  it("sentence-cases a generated call to action", () => {
    expect(bookingLabel("Book Your Cut")).toBe("Book your cut");
    expect(bookingLabel("Book Now")).toBe("Book now");
    expect(bookingLabel("BOOK YOUR APPOINTMENT")).toBe("Book your appointment");
  });

  it("uses the verb Book for every booking verb", () => {
    expect(bookingLabel("Reserve Your Chair")).toBe("Book your chair");
    expect(bookingLabel("Secure your slot")).toBe("Book your slot");
  });

  it("keeps the shop's and the team's names capitalised, and lowers everything else", () => {
    expect(bookingLabel("Book With Kofi", ["Kofi Asante"])).toBe("Book with Kofi");
    expect(bookingLabel("Book Your Fresh Fade")).toBe("Book your fresh fade");
    expect(bookingLabel("Book At Linden & Lark", ["Linden & Lark Hair Studio"])).toBe("Book at Linden & Lark");
  });

  it("leaves a label that is already in sentence case alone", () => {
    expect(bookingLabel("Book with Kofi")).toBe("Book with Kofi");
    expect(bookingLabel("Book your cut")).toBe("Book your cut");
  });

  it("falls back when there is no usable booking label", () => {
    expect(bookingLabel(undefined)).toBe(DEFAULT_BOOK_LABEL);
    expect(bookingLabel("  ")).toBe(DEFAULT_BOOK_LABEL);
    expect(bookingLabel("Visit us")).toBe(DEFAULT_BOOK_LABEL);
    expect(bookingLabel("Bookmark this page")).toBe(DEFAULT_BOOK_LABEL);
    expect(bookingLabel("Get Booked")).toBe(DEFAULT_BOOK_LABEL);
    expect(bookingLabel("Book your first relaxing appointment with our whole team")).toBe(DEFAULT_BOOK_LABEL);
  });

  it("drops a trailing arrow or full stop, which the buttons draw themselves", () => {
    expect(bookingLabel("Book now →")).toBe("Book now");
    expect(bookingLabel("Book today!")).toBe("Book today");
  });
});

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
