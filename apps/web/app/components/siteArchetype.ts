/** Layout + copy archetypes for generated shop sites (WS-6 uniqueness).
 *
 *  `archetypeFor` maps a site's `layout_mood` to a full archetype config.
 *  Absent or unknown moods fall back to `luxury-dark`, which reproduces the
 *  template's original behaviour exactly, so pre-WS-6 sites render unchanged.
 */

export type SectionKey =
  | "trust"
  | "services"
  | "about"
  | "team"
  | "how"
  | "reviews"
  | "location";

export type ArchetypeStep = { t: string; d: string };

export type Archetype = {
  /** Hero text alignment; "center" also centres the inner container and CTA row. */
  heroAlign: "left" | "center";
  /** "screen" = min-h-screen, "tall" = min-h-[85vh]. */
  heroMinH: "screen" | "tall";
  /** Order of the middle sections. Hero is always first, final CTA always last. */
  order: SectionKey[];
  /** Column count for service cards at the lg breakpoint. */
  servicesCols: 2 | 3;
  /** "icons" = icon-list pillars; "chips" = accent-bordered badges without icons. */
  pillarStyle: "icons" | "chips";
  /** "grid" = 3-col centred steps; "row" = left-aligned vertical list with numbered circles. */
  stepsStyle: "grid" | "row";
  /** false removes the decorative blur/glow divs for an understated look. */
  glow: boolean;
  /** Subheading under the "How it works" title. */
  howSub: string;
  /** Final CTA heading and subline. */
  ctaHeading: string;
  ctaSub: string;
  /** The three how-it-works steps. */
  steps: [ArchetypeStep, ArchetypeStep, ArchetypeStep];
};

type ArchetypeCopy = Pick<Archetype, "howSub" | "ctaHeading" | "ctaSub" | "steps">;

/** Variant 1: the template's original literals (luxury-dark, classic-traditional). */
const copyClassic: ArchetypeCopy = {
  howSub: "Three steps from browsing to booked, about sixty seconds.",
  ctaHeading: "Ready for your best look?",
  ctaSub: "Book your appointment in 60 seconds.",
  steps: [
    { t: "Choose a service", d: "Browse treatments and pick what suits you." },
    { t: "Pick your time", d: "Select a staff member and a slot that fits your diary." },
    { t: "Confirm your booking", d: "Lock in your slot instantly. No card required." },
  ],
};

/** Variant 2: calm and understated (modern-minimal, warm-editorial). */
const copyUnderstated: ArchetypeCopy = {
  howSub: "Booking online takes about a minute from start to finish.",
  ctaHeading: "Your next appointment is a minute away",
  ctaSub: "Choose a time that suits you and we will take care of the rest.",
  steps: [
    { t: "Browse the services", d: "Take your time and find the treatment that suits you." },
    { t: "Choose a time", d: "Pick a day and a slot that fits around your week." },
    { t: "You are booked in", d: "Confirmation is instant and no card is required." },
  ],
};

/** Variant 3: upbeat and direct (bold-vibrant, fresh-pastel). */
const copyEnergetic: ArchetypeCopy = {
  howSub: "From browsing to booked in three quick steps.",
  ctaHeading: "Fancy a fresh look?",
  ctaSub: "Grab a slot online, it only takes a minute.",
  steps: [
    { t: "Pick your treatment", d: "Find the service that catches your eye." },
    { t: "Lock in a slot", d: "Choose who you want to see and when suits you." },
    { t: "Done, see you soon", d: "Your slot is confirmed instantly, no card needed." },
  ],
};

/** The default archetype: matches the pre-WS-6 template exactly. */
const luxuryDark: Archetype = {
  heroAlign: "left",
  heroMinH: "screen",
  order: ["trust", "services", "about", "team", "how", "reviews", "location"],
  servicesCols: 3,
  pillarStyle: "icons",
  stepsStyle: "grid",
  glow: true,
  ...copyClassic,
};

const archetypes: Record<string, Archetype> = {
  "luxury-dark": luxuryDark,
  "modern-minimal": {
    heroAlign: "center",
    heroMinH: "tall",
    order: ["trust", "services", "how", "about", "team", "reviews", "location"],
    servicesCols: 3,
    pillarStyle: "icons",
    stepsStyle: "row",
    glow: false,
    ...copyUnderstated,
  },
  "bold-vibrant": {
    heroAlign: "left",
    heroMinH: "screen",
    order: ["trust", "services", "reviews", "about", "team", "how", "location"],
    servicesCols: 3,
    pillarStyle: "chips",
    stepsStyle: "grid",
    glow: true,
    ...copyEnergetic,
  },
  "warm-editorial": {
    heroAlign: "center",
    heroMinH: "tall",
    order: ["trust", "about", "services", "team", "reviews", "how", "location"],
    servicesCols: 2,
    pillarStyle: "icons",
    stepsStyle: "row",
    glow: false,
    ...copyUnderstated,
  },
  "classic-traditional": {
    heroAlign: "center",
    heroMinH: "tall",
    order: ["trust", "about", "services", "team", "how", "reviews", "location"],
    servicesCols: 2,
    pillarStyle: "icons",
    stepsStyle: "grid",
    glow: false,
    ...copyClassic,
  },
  "fresh-pastel": {
    heroAlign: "center",
    heroMinH: "screen",
    order: ["trust", "services", "team", "about", "how", "reviews", "location"],
    servicesCols: 3,
    pillarStyle: "chips",
    stepsStyle: "grid",
    glow: true,
    ...copyEnergetic,
  },
};

/** Resolve a layout mood to its archetype; unknown or absent moods get the default. */
export function archetypeFor(layoutMood: string | undefined): Archetype {
  if (typeof layoutMood !== "string") return luxuryDark;
  return archetypes[layoutMood.trim().toLowerCase()] ?? luxuryDark;
}
