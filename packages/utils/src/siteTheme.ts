/**
 * WS-6 item 3+4: palette-driven site theming with a WCAG contrast guard, plus
 * deterministic per-shop variation tokens.
 *
 * `resolveSiteTheme` turns a generated site's palette into the full set of CSS
 * custom properties the commercial template renders with. Two paths:
 *
 * - **Legacy** (`design_version < 2`, or no usable palette): every token gets
 *   the exact colour value the template hardcoded before tokenisation, so
 *   existing sites render unchanged until they are regenerated.
 * - **v2** (`design_version >= 2` with a palette): the page background comes
 *   from `palette.background` (light or dark), foreground ink from
 *   `palette.text`, and every derived tone is computed per scheme. Guards
 *   (WCAG AA body text, 4.5:1): ink, every text ink step and accent-as-text
 *   must clear 4.5:1 on every surface the template draws them on, not just
 *   the page: the strongest translucent ink wash (chips, panels, the footer)
 *   and, for accent text, the strongest accent tint behind it. Accent text is
 *   small (nav links, category labels, specialities, "Book with", the selected
 *   time), so the 3:1 large-text threshold never applied. The on-accent
 *   colour is whichever of black/white contrasts better with the accent.
 *
 * All functions are pure and deterministic — no Date, no randomness — so SSR
 * and hydration always agree.
 */

export interface SiteThemeInput {
  /** Legacy brand colour (today's page background). */
  color_primary?: string | null;
  /** Legacy accent colour. */
  color_accent?: string | null;
  /** Full 5-colour palette from the research spec (shop_sites.palette_json). */
  palette?: Record<string, string> | null;
  /** shop_sites.design_version — palette theming + variation gate on >= 2. */
  design_version?: number | null;
  /** Seed for the per-shop variation tokens. */
  shop_id?: string | null;
}

export interface ResolvedSiteTheme {
  scheme: "dark" | "light";
  /** CSS custom properties to set on the site root element. */
  vars: Record<string, string>;
}

type Rgb = { r: number; g: number; b: number };

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): Rgb | null {
  const t = hex.trim();
  if (!HEX6.test(t)) return null;
  return {
    r: parseInt(t.slice(1, 3), 16),
    g: parseInt(t.slice(3, 5), 16),
    b: parseInt(t.slice(5, 7), 16),
  };
}

function channelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance (0 = black, 1 = white). */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * channelToLinear(c.r) + 0.7152 * channelToLinear(c.g) + 0.0722 * channelToLinear(c.b);
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function rgba(c: Rgb, alpha: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

function hex(c: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * Nudge `fg` toward whichever of black/white contrasts more with `bg` until
 * the ratio is met (5% steps). Falls back to pure black/white — which always
 * meets any achievable ratio against a non-matching background.
 */
export function ensureContrast(fg: Rgb, bg: Rgb, minRatio: number): Rgb {
  if (contrastRatio(fg, bg) >= minRatio) return fg;
  const target = relativeLuminance(bg) >= 0.5 ? BLACK : WHITE;
  for (let t = 0.05; t < 1; t += 0.05) {
    const candidate = mix(fg, target, t);
    if (contrastRatio(candidate, bg) >= minRatio) return candidate;
  }
  return target;
}

/**
 * `ensureContrast` against several surfaces at once: `fg` is nudged (1% steps,
 * so a brand colour keeps as much of its hue as AA allows) until it clears
 * `minRatio` on EVERY surface. The direction (toward black or white) is chosen
 * from the first surface, the page background. Returns `fg` itself when it
 * already passes.
 */
export function ensureContrastOnAll(fg: Rgb, surfaces: readonly Rgb[], minRatio: number): Rgb {
  const passes = (c: Rgb) => surfaces.every((s) => contrastRatio(c, s) >= minRatio);
  if (passes(fg)) return fg;
  const target = relativeLuminance(surfaces[0]!) >= 0.5 ? BLACK : WHITE;
  for (let step = 1; step < 100; step++) {
    const candidate = mix(fg, target, step / 100);
    if (passes(candidate)) return candidate;
  }
  return target;
}

// ─── Per-shop variation (item 4) ─────────────────────────────────────────────

/** FNV-1a 32-bit — stable, dependency-free string hash. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Radius scales: [rounded-2xl slot, rounded-xl slot, rounded-lg slot]. Index 1 is the legacy scale. */
const RADIUS_SCALES: ReadonlyArray<readonly [string, string, string]> = [
  ["0.75rem", "0.5rem", "0.375rem"], // compact
  ["1rem", "0.75rem", "0.5rem"], // classic (legacy values)
  ["1.25rem", "1rem", "0.625rem"], // soft
];

/** Card border alphas; index 1 is the legacy value (border-white/10). */
const CARD_LINE_ALPHAS: readonly number[] = [0.08, 0.1, 0.14];

// ─── Theme resolution (item 3) ───────────────────────────────────────────────

const LEGACY_BG = "#1a1a1a";
const LEGACY_ACCENT = "#d4a853";

/** Alpha steps the template uses for foreground ink (text-white/NN today). */
const INK_STEPS = [25, 30, 40, 45, 50, 55, 60, 70, 75, 80, 85, 90, 95] as const;
/** Ink steps at or above this carry text (muted copy, captions, meta lines). */
const TEXT_INK_FLOOR_STEP = 40;

/** Lowest opacity >= `alpha` at which `ink` composited over each surface
 *  clears 4.5:1 on that surface (WCAG AA, small text). On a light palette the
 *  plain /55 step measured 3.5:1 on the page, and the lifted steps still
 *  measured 4.3:1 on the footer's ink wash, so every surface counts; a dark
 *  palette already passes and keeps its exact value. `ink` itself is
 *  contrast-checked on every surface, so 1 passes. */
function readableInkAlpha(ink: Rgb, surfaces: readonly Rgb[], alpha: number): number {
  for (let a = alpha; a < 1; a = Math.round((a + 0.01) * 100) / 100) {
    if (surfaces.every((s) => contrastRatio(mix(s, ink, a), s) >= 4.5)) return a;
  }
  return 1;
}

/** Strongest translucent ink wash text is drawn on, per scheme: light pages
 *  use rgba(ink, 0.08) for chips, panel-3 and bubbles; dark pages use
 *  rgba(ink, 0.1) for chips. Keep in step with the tokens below. */
const MAX_INK_WASH = { light: 0.08, dark: 0.1 } as const;
/** Strongest accent tint drawn behind accent-coloured text (--st-accent-25,
 *  the team initials; the selected time sits on -20, step numbers on -15). */
const MAX_ACCENT_TINT = 0.25;
/** Alpha steps for hairline borders (border-white/NN today). */
const LINE_STEPS = [10, 15, 20, 40] as const;
/** Alpha steps for accent tints (bg/border/ring-accent/NN today). */
const ACCENT_STEPS = [7, 8, 10, 15, 20, 25, 40, 50] as const;

function parseHexOr(v: string | null | undefined, fallback: Rgb): Rgb {
  return (typeof v === "string" ? hexToRgb(v) : null) ?? fallback;
}

export function resolveSiteTheme(input: SiteThemeInput): ResolvedSiteTheme {
  const legacyBg = parseHexOr(input.color_primary, hexToRgb(LEGACY_BG)!);
  const legacyAccent = parseHexOr(input.color_accent, hexToRgb(LEGACY_ACCENT)!);

  const palette = input.palette ?? null;
  const paletteBg = palette ? hexToRgb(palette.background ?? "") : null;
  const v2 = (input.design_version ?? 1) >= 2 && paletteBg !== null;

  const vars: Record<string, string> = {};
  let scheme: "dark" | "light";
  let bg: Rgb;
  let ink: Rgb;
  let accent: Rgb;
  let brand: Rgb;

  if (!v2) {
    // Legacy: reproduce the pre-token rendering exactly.
    scheme = "dark";
    bg = legacyBg;
    ink = WHITE;
    accent = legacyAccent;
    brand = legacyBg;
    vars["--st-accent-text"] = hex(accent);
    vars["--st-on-accent"] = "#000000";
    for (const s of INK_STEPS) vars[`--st-ink-${s}`] = rgba(WHITE, s / 100);
    for (const s of LINE_STEPS) vars[`--st-line-${s}`] = rgba(WHITE, s / 100);
    vars["--st-card"] = rgba(WHITE, 0.04);
    vars["--st-card-hover"] = rgba(WHITE, 0.06);
    vars["--st-card-5"] = rgba(WHITE, 0.05);
    vars["--st-card-faint"] = rgba(WHITE, 0.03);
    vars["--st-chip"] = rgba(WHITE, 0.1);
    vars["--st-field"] = rgba(BLACK, 0.25);
    vars["--st-panel-1"] = rgba(BLACK, 0.15);
    vars["--st-panel-2"] = rgba(BLACK, 0.2);
    vars["--st-panel-3"] = rgba(BLACK, 0.3);
    vars["--st-bubble"] = "#3f3f46"; // tailwind zinc-700
    vars["--st-shadow-20"] = rgba(BLACK, 0.2);
    vars["--st-shadow-25"] = rgba(BLACK, 0.25);
    vars["--st-shadow-30"] = rgba(BLACK, 0.3);
  } else {
    bg = paletteBg!;
    // Scheme = whichever ink extreme reads better on this background.
    scheme = contrastRatio(WHITE, bg) >= contrastRatio(BLACK, bg) ? "dark" : "light";
    const inkStart = parseHexOr(palette!.text, scheme === "dark" ? WHITE : { r: 20, g: 20, b: 20 });
    // The wash is made from the ink itself, so settle the ink first: a guard
    // that darkens (or lightens) it also moves the wash it is checked on.
    const washAlpha = MAX_INK_WASH[scheme];
    ink = ensureContrast(inkStart, bg, 4.5);
    for (let i = 0; i < 3; i++) {
      const next = ensureContrastOnAll(ink, [bg, mix(bg, ink, washAlpha)], 4.5);
      if (next === ink) break;
      ink = next;
    }
    const wash = mix(bg, ink, washAlpha);
    const textSurfaces = [bg, wash];
    accent = parseHexOr(palette!.accent, legacyAccent);
    brand = parseHexOr(palette!.primary, legacyBg);
    const accentSurfaces = [bg, wash, mix(bg, accent, MAX_ACCENT_TINT), mix(wash, accent, MAX_ACCENT_TINT)];
    vars["--st-accent-text"] = hex(ensureContrastOnAll(accent, accentSurfaces, 4.5));
    vars["--st-on-accent"] =
      contrastRatio(BLACK, accent) >= contrastRatio(WHITE, accent) ? "#000000" : "#ffffff";
    for (const s of INK_STEPS) {
      vars[`--st-ink-${s}`] = rgba(ink, s >= TEXT_INK_FLOOR_STEP ? readableInkAlpha(ink, textSurfaces, s / 100) : s / 100);
    }
    for (const s of LINE_STEPS) vars[`--st-line-${s}`] = rgba(ink, s / 100);
    if (scheme === "dark") {
      vars["--st-card"] = rgba(ink, 0.04);
      vars["--st-card-hover"] = rgba(ink, 0.06);
      vars["--st-card-5"] = rgba(ink, 0.05);
      vars["--st-card-faint"] = rgba(ink, 0.03);
      vars["--st-chip"] = rgba(ink, 0.1);
      vars["--st-field"] = rgba(BLACK, 0.25);
      vars["--st-panel-1"] = rgba(BLACK, 0.15);
      vars["--st-panel-2"] = rgba(BLACK, 0.2);
      vars["--st-panel-3"] = rgba(BLACK, 0.3);
      vars["--st-bubble"] = "#3f3f46";
      vars["--st-shadow-20"] = rgba(BLACK, 0.2);
      vars["--st-shadow-25"] = rgba(BLACK, 0.25);
      vars["--st-shadow-30"] = rgba(BLACK, 0.3);
    } else {
      // Light scheme: cards lift to white, panels are faint ink washes, and
      // shadows soften — 20%+ black shadows read as smears on light pages.
      vars["--st-card"] = "#ffffff";
      vars["--st-card-hover"] = "#ffffff";
      vars["--st-card-5"] = "#ffffff";
      vars["--st-card-faint"] = rgba(ink, 0.03);
      vars["--st-chip"] = rgba(ink, 0.08);
      vars["--st-field"] = rgba(ink, 0.05);
      vars["--st-panel-1"] = rgba(ink, 0.035);
      vars["--st-panel-2"] = rgba(ink, 0.05);
      vars["--st-panel-3"] = rgba(ink, 0.08);
      vars["--st-bubble"] = rgba(ink, 0.08);
      vars["--st-shadow-20"] = rgba(BLACK, 0.08);
      vars["--st-shadow-25"] = rgba(BLACK, 0.1);
      vars["--st-shadow-30"] = rgba(BLACK, 0.12);
    }
  }

  vars["--st-bg"] = hex(bg);
  vars["--st-ink"] = hex(ink);
  vars["--st-header"] = rgba(bg, 0.95);
  vars["--color-brand"] = hex(brand);
  vars["--color-accent"] = hex(accent);
  for (const s of ACCENT_STEPS) {
    vars[`--st-accent-${String(s).padStart(2, "0")}`] = rgba(accent, s / 100);
  }

  // Item 4: deterministic per-shop variation. v2 sites draw a coherent radius
  // scale and card hairline weight from the shop id; legacy sites keep the
  // exact stock values.
  const seedBase = v2 && input.shop_id ? fnv1a(input.shop_id) : null;
  const radiusScale = RADIUS_SCALES[seedBase === null ? 1 : seedBase % RADIUS_SCALES.length]!;
  const cardLineAlpha =
    CARD_LINE_ALPHAS[seedBase === null ? 1 : fnv1a(`${input.shop_id}:line`) % CARD_LINE_ALPHAS.length]!;
  vars["--st-r-lg"] = radiusScale[0];
  vars["--st-r-md"] = radiusScale[1];
  vars["--st-r-sm"] = radiusScale[2];
  vars["--st-line-card"] = rgba(ink, cardLineAlpha);

  return { scheme, vars };
}
