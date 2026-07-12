/**
 * WS-6 item 5: the curated, SELF-HOSTED font set. Every family here ships as
 * @fontsource woff2 assets bundled with the web app — no Google Fonts request
 * ever leaves the visitor's browser (LEG-5: pre-consent third-party transfer).
 *
 * The AI pipeline is pinned to these names (research prompt + post-force in
 * the research worker, and again defensively in the builder). Those two
 * workers do not depend on @repo/utils, so they carry a synced copy of this
 * list — grep for CURATED_FONT_NAMES when changing it:
 *   apps/workers/research/src/index.ts
 *   apps/workers/builder/src/index.ts
 * Weights 400/500/600/700 are bundled for every family except Libre
 * Baskerville (400/700 only — the family has no intermediate cuts).
 */

export type CuratedFontKind = "serif" | "sans-serif";

export const CURATED_FONTS: Record<string, CuratedFontKind> = {
  "Playfair Display": "serif",
  "Cormorant Garamond": "serif",
  "Libre Baskerville": "serif",
  Lora: "serif",
  "DM Sans": "sans-serif",
  Jost: "sans-serif",
  Montserrat: "sans-serif",
  Inter: "sans-serif",
  "Work Sans": "sans-serif",
  "Space Grotesk": "sans-serif",
};

export const CURATED_FONT_NAMES = Object.keys(CURATED_FONTS);

/** Legacy defaults — what the pre-WS-6 fallback stacks rendered when a stored
 *  font failed to load, so unknown names keep their historical appearance. */
const DEFAULT_BY_ROLE: Record<"heading" | "body", Record<CuratedFontKind, string>> = {
  heading: { serif: "Playfair Display", "sans-serif": "Montserrat" },
  body: { serif: "Lora", "sans-serif": "DM Sans" },
};

function normalizeKindHint(hint: string | null | undefined): CuratedFontKind | null {
  if (!hint) return null;
  const h = hint.toLowerCase();
  // "sans-serif".includes("serif") is true — check sans first.
  if (h.includes("sans")) return "sans-serif";
  if (h.includes("serif")) return "serif";
  return null;
}

/**
 * Map a stored/AI-proposed font name onto the curated set.
 * Exact (case-insensitive) matches keep their family; anything else falls to
 * the role's default, honouring a serif/sans style hint when one is stored.
 */
export function resolveCuratedFont(
  name: string | null | undefined,
  role: "heading" | "body",
  styleHint?: string | null
): { family: string; kind: CuratedFontKind } {
  const wanted = (name ?? "").trim().toLowerCase();
  if (wanted) {
    for (const [family, kind] of Object.entries(CURATED_FONTS)) {
      if (family.toLowerCase() === wanted) return { family, kind };
    }
  }
  const hinted = normalizeKindHint(styleHint);
  const kind = hinted ?? (role === "heading" ? "serif" : "sans-serif");
  const family = DEFAULT_BY_ROLE[role][kind];
  return { family, kind: CURATED_FONTS[family]! };
}

/** CSS font-family stack for a curated family. */
export function curatedFontStack(family: string): string {
  const kind = CURATED_FONTS[family] ?? "sans-serif";
  return kind === "serif"
    ? `"${family}", Georgia, serif`
    : `"${family}", system-ui, sans-serif`;
}
