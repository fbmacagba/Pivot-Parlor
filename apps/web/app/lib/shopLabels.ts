/** Two-letter monogram for a shop without a logo. Words only: "Linden & Lark"
 *  is "LL", not "L&". */
export function shopNameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => /\p{L}|\p{N}/u.test(p));
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase() || "?";
}

/** The shop's one booking label. */
export const DEFAULT_BOOK_LABEL = "Book now";
/** The one label for the "see what's on offer" action. */
export const VIEW_SERVICES_LABEL = "View services";

// Booking verbs a generated call to action may open with; each becomes "Book",
// so a shop's buttons all use one verb. ("Get" is not one: "Get booked".)
const BOOKING_VERBS = /^(book|reserve|schedule|secure|claim|grab|make|request)\b\s*/i;

/**
 * The shop's primary booking label in sentence case with the verb "Book",
 * from the generated call to action when there is a usable one. A Title Case
 * or ALL CAPS label is lowered word by word, except the shop's and the team's
 * own names (`names`), which keep their capitals. Anything that is not a
 * booking action, or longer than a short button can carry, is "Book now".
 */
export function bookingLabel(heroCta: string | null | undefined, names: string[] = []): string {
  const raw = (heroCta ?? "").replace(/\s+/g, " ").replace(/[→>]+\s*$/, "").trim();
  if (!raw) return DEFAULT_BOOK_LABEL;
  const rest = raw.replace(BOOKING_VERBS, "");
  if (rest === raw) return DEFAULT_BOOK_LABEL; // not a booking action ("Visit us")
  const words = rest.split(" ").filter(Boolean);
  const lettered = words.filter((w) => /\p{L}/u.test(w));
  const shouting = lettered.length > 0 && lettered.every((w) => /^\P{Ll}+$/u.test(w));
  const titled = lettered.length > 0 && lettered.every((w) => /^\P{L}*\p{Lu}/u.test(w));
  const proper = new Map<string, string>();
  for (const n of names) {
    for (const w of n.split(/\s+/)) {
      const bare = w.replace(/[^\p{L}\p{N}'’]/gu, "");
      if (bare) proper.set(bare.toLowerCase(), bare);
    }
  }
  const cased =
    shouting || titled
      ? words.map((w) => {
          const bare = w.replace(/[^\p{L}\p{N}'’]/gu, "");
          const keep = proper.get(bare.toLowerCase());
          return keep ? w.replace(bare, keep) : w.toLowerCase();
        })
      : words;
  const label = ["Book", ...cased].join(" ").replace(/[.!]+$/, "");
  return label.length <= 24 ? label : DEFAULT_BOOK_LABEL;
}

/** True only for a service the owner filed under a retail category. Every row
 *  in the services table is a bookable appointment; the old name-keyword guess
 *  ("beard", "wax", "gel", "oil", "spray"...) hid real services such as a beard
 *  sculpt, leg wax, gel nails or a spray tan from the chat menu and put a
 *  stock "Grooming products, In-store" line in their place. */
export function isRetailCategory(category: string | null | undefined): boolean {
  return /^(products?|retail)$/i.test((category ?? "").trim());
}
