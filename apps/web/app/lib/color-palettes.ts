// Curated colour palettes offered when spawning / restyling a shop site.
// `primary` is the site's dark brand base (→ color_primary → --color-brand);
// `accent` is the highlight used for CTAs and prices (→ color_accent → --color-accent).
// Shared by the owner creation flow (setup.template-select) and the developer
// AI-deploy panel (dev.shops) so both pickers offer an identical, click-only set.

export interface ColorPalette {
  id: string;
  name: string;
  /** Dark brand base — maps to the site's color_primary. */
  primary: string;
  /** Highlight / CTA colour — maps to the site's color_accent. */
  accent: string;
}

export const COLOR_PALETTES: readonly ColorPalette[] = [
  { id: "onyx-gold",          name: "Onyx & Gold",          primary: "#0D0D0D", accent: "#C9A84C" },
  { id: "charcoal-amber",     name: "Charcoal & Amber",     primary: "#181613", accent: "#E0A24E" },
  { id: "espresso-copper",    name: "Espresso & Copper",    primary: "#1A1310", accent: "#C8825A" },
  { id: "burgundy-champagne", name: "Burgundy & Champagne", primary: "#1E0E12", accent: "#D8B48A" },
  { id: "midnight-ice",       name: "Midnight & Ice",       primary: "#0E1422", accent: "#7FB0DC" },
  { id: "forest-sage",        name: "Forest & Sage",        primary: "#0E1A14", accent: "#83C28C" },
  { id: "plum-rose",          name: "Plum & Rose",          primary: "#170E1C", accent: "#D69BB0" },
  { id: "slate-coral",        name: "Slate & Coral",        primary: "#14161C", accent: "#E07C5C" },
] as const;

export const DEFAULT_PALETTE: ColorPalette = COLOR_PALETTES[0]!;

/** True for a valid 6-digit hex colour like #C9A84C. */
export function isHex6(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

/** Find the palette whose primary+accent match the given colours, else null. */
export function paletteFromColors(
  primary?: string | null,
  accent?: string | null
): ColorPalette | null {
  if (!primary || !accent) return null;
  const p = primary.trim().toLowerCase();
  const a = accent.trim().toLowerCase();
  return (
    COLOR_PALETTES.find(
      (pal) => pal.primary.toLowerCase() === p && pal.accent.toLowerCase() === a
    ) ?? null
  );
}
