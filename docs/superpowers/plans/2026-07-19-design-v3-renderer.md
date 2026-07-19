# Design v3 Renderer Skeleton Implementation Plan (Spec PR 2b-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the monolithic `CommercialTemplate` into per-section components and add a `design_spec`-driven composer for `design_version >= 3` sites — with rendered-HTML parity proven by test, so nothing changes visually for any existing or new site until PR 2b-2 ships the variant library.

**Architecture:** All markup moves VERBATIM out of `CommercialTemplate.tsx` (585 lines at main `f88adbd`) into `apps/web/app/components/site/sections/*`, each component taking a shared `SiteRenderContext` plus explicit display options. The legacy path (v1/v2) keeps rendering through `archetypeFor` exactly as today, now via the extracted components. A new pure `composeRenderPlan(design_spec)` maps a spec to hero options + an ordered section list (in 2b-1 every variant id maps to the single existing component per section — v3 output is deliberately indistinguishable from v2 until 2b-2), and `design_spec` is plumbed worker -> loader -> `SiteData`. A jsdom parity test renders both paths with `renderToStaticMarkup` and asserts byte-identical HTML.

**Tech Stack:** React/Remix (apps/web), vitest + jsdom with `vi.mock("@remix-run/react")`, Hono worker (one endpoint touch).

## Global Constraints

- Branch `feat/design-v3-renderer` off `main` (f88adbd or later). Plain PR to main — no stacking. User merges after CI green; never `--auto`.
- **Parity is the contract:** every extraction is a verbatim move — className strings, element order, conditional-render rules (`team` needs staff, `reviews` needs reviews, `location` needs an address) must survive unchanged. The Task 5 parity test is the oracle; treat any diff it reports as a bug in the extraction, never as "close enough".
- v3 route branch requires BOTH `design_version >= 3` AND a design_spec that survives `normalizeDesignSpec`; anything else falls back to the legacy path (a broken stored spec must never blank a site).
- No new dependencies. No em-dashes in user-facing text. Dim text tokens stay exactly as moved. No stale `.js` route twins (`$shopSlug._index`, `$shopSlug`).
- No migration (044 already ships the column). Worker `/site` endpoint gains only the parsed `design_spec` passthrough.
- Copy remains mood-driven: the v3 composer takes `howSub`/`cta*`/`steps` from `archetypeFor(site.layout_mood)` exactly like the legacy path — the spec drives LAYOUT, not copy.

---

### Task 1: Section context + hero and final-CTA extraction

**Files:**
- Create: `apps/web/app/components/site/sectionContext.ts`
- Create: `apps/web/app/components/site/sections/HeroSection.tsx`
- Create: `apps/web/app/components/site/sections/FinalCtaSection.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx`

**Interfaces:**
- Produces (used by every later task):

```ts
// sectionContext.ts — the data every section may need, built once per render.
import type { ReactNode } from "react";
import type { SiteData, ShopSettings } from "~/components/commercialSiteTypes";
import type { StaffMember, Service, Review } from "~/components/CommercialTemplate";
import type { Archetype } from "~/components/siteArchetype";

export interface SitePillar { title: string; body?: string; icon: ReactNode }
export interface SiteStep { n: string; t: string; d: string; icon: ReactNode }

export interface SiteRenderContext {
  site: SiteData;
  settings: ShopSettings;
  shopSlug: string;
  services: Service[];
  filteredServices: Service[];
  categories: string[];
  category: string;
  setCategory: (c: string) => void;
  staff: StaffMember[];
  sortedReviews: Review[];
  reviewCount: number;
  hasAddress: boolean;
  hasSocialProof: boolean;
  statsHappy: string;
  statsRating: string;
  trustSignals: string[];
  heroSubline: string;
  heroHeadline: string;
  heroTagline: string;
  heroSrc: string;
  aboutText: string;
  aboutHeading: string;
  bookLabel: string;
  pillars: SitePillar[];
  steps: SiteStep[];
  archetype: Archetype; // copy source (howSub, cta*, steps text) for BOTH paths
  scrollToId: (id: string) => void;
}
```

- `HeroSection({ ctx, centered, minH, }: { ctx: SiteRenderContext; centered: boolean; minH: "screen" | "tall" })` — the hero `<section>` from CommercialTemplate.tsx lines 491-561 moved verbatim (`heroCentered` -> `centered`, `heroMinHClass` computed inside from `minH`).
- `FinalCtaSection({ ctx, glow }: { ctx: SiteRenderContext; glow: boolean })` — the final CTA `<section>` from lines 568-582 moved verbatim (`archetype.glow` -> `glow`; heading/sub/label read from `ctx.archetype` / `ctx.bookLabel`).

- [ ] **Step 1: Create `sectionContext.ts`** with exactly the interface above (plus the two helper types). No logic — types only.

- [ ] **Step 2: Extract the two components**

Move the hero JSX (lines 491-561, from `{/* Hero */}` through its closing `</section>`) into `HeroSection.tsx` and the final CTA (lines 568-582) into `FinalCtaSection.tsx`. Rules:
- Copy the JSX byte-for-byte; only identifier references change (`site.` -> `ctx.site.`, `heroSrc` -> `ctx.heroSrc`, `shopSlug` -> `ctx.shopSlug`, `bookLabel` -> `ctx.bookLabel`, `heroSubline` -> `ctx.heroSubline`, `hasSocialProof`/`statsRating`/`reviewCount`/`scrollToId` likewise; `archetype.ctaHeading`/`ctaSub`/`glow` -> `ctx.archetype.ctaHeading`/`ctx.archetype.ctaSub`/`glow` prop).
- `heroMinHClass` becomes `const minHClass = minH === "tall" ? "min-h-[85vh]" : "min-h-screen";` inside HeroSection (the string values must match the current ones exactly).
- Each file imports `Link` from `@remix-run/react` and `StarRow` — move `StarRow` (lines 84-95) into a new shared file `apps/web/app/components/site/sections/bits.tsx` exported alongside `formatReviewDate` (lines 78-82) and `HoursTable` + `parseHours` (lines 65-76, 97-125), all verbatim; `CommercialTemplate.tsx` imports them back from there so nothing else breaks.

- [ ] **Step 3: Rewire `CommercialTemplate` to use them**

In the return JSX replace the hero block with `<HeroSection ctx={ctx} centered={heroCentered} minH={archetype.heroMinH} />` and the final CTA with `<FinalCtaSection ctx={ctx} glow={archetype.glow} />`, where `ctx` is a `SiteRenderContext` object literal assembled from the existing locals (all already computed in the component body — this is a pure aggregation, no logic moves). Keep every local computation exactly where it is.

- [ ] **Step 4: Verify**

Run: `cd apps/web && npx tsc && npx vitest run && npm run build` — all green. Then eyeball `git diff` to confirm the extracted JSX hunks are pure moves (deletions in CommercialTemplate matching additions in the new files, modulo the `ctx.` prefixes).

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/site apps/web/app/components/CommercialTemplate.tsx
git commit -m "refactor(site): extract hero + final CTA into section components (verbatim)"
```

---

### Task 2: Extract the seven middle sections

**Files:**
- Create: `apps/web/app/components/site/sections/TrustSection.tsx`, `ServicesSection.tsx`, `AboutSection.tsx`, `TeamSection.tsx`, `HowSection.tsx`, `ReviewsSection.tsx`, `LocationSection.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx`

**Interfaces (produced; Task 4 relies on these exact signatures):**

```ts
TrustSection({ ctx }: { ctx: SiteRenderContext })
ServicesSection({ ctx, cols, glow }: { ctx: SiteRenderContext; cols: 2 | 3; glow: boolean })
AboutSection({ ctx, pillarStyle }: { ctx: SiteRenderContext; pillarStyle: "icons" | "chips" })
TeamSection({ ctx }: { ctx: SiteRenderContext })          // returns null when ctx.staff is empty
HowSection({ ctx, stepsStyle, glow }: { ctx: SiteRenderContext; stepsStyle: "grid" | "row"; glow: boolean })  // howSub from ctx.archetype
ReviewsSection({ ctx }: { ctx: SiteRenderContext })       // returns null when ctx.sortedReviews is empty
LocationSection({ ctx }: { ctx: SiteRenderContext })      // returns null when !ctx.hasAddress
```

- [ ] **Step 1: Move each section's JSX verbatim** from the `sections` Record (CommercialTemplate.tsx lines 219-487) into its component. Same rules as Task 1: byte-identical markup, identifiers re-pointed at `ctx.` / props (`archetype.glow` -> `glow` prop, `servicesColsClass` computed inside ServicesSection from `cols` with the exact same strings, `archetype.pillarStyle` -> `pillarStyle` prop, `archetype.stepsStyle` -> `stepsStyle` prop, `archetype.howSub` -> `ctx.archetype.howSub`). The null-condition (team/reviews/location) moves INTO each component as an early return.

- [ ] **Step 2: Rebuild the `sections` Record in CommercialTemplate** as thin calls:

```tsx
const sections: Record<SectionKey, ReactNode> = {
  trust: <TrustSection ctx={ctx} />,
  services: <ServicesSection ctx={ctx} cols={archetype.servicesCols} glow={archetype.glow} />,
  about: <AboutSection ctx={ctx} pillarStyle={archetype.pillarStyle} />,
  team: <TeamSection ctx={ctx} />,
  how: <HowSection ctx={ctx} stepsStyle={archetype.stepsStyle} glow={archetype.glow} />,
  reviews: <ReviewsSection ctx={ctx} />,
  location: <LocationSection ctx={ctx} />,
};
```

- [ ] **Step 3: Verify** — `cd apps/web && npx tsc && npx vitest run && npm run build` green; diff-audit that every deleted hunk reappears verbatim in a component.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/components/site/sections apps/web/app/components/CommercialTemplate.tsx
git commit -m "refactor(site): extract the seven middle sections (verbatim moves)"
```

---

### Task 3: Pure render-plan mapping

**Files:**
- Create: `apps/web/app/components/site/composePlan.ts`
- Test: `apps/web/app/components/site/composePlan.test.ts`

**Interfaces (produced):**

```ts
import type { DesignSpec, DesignSectionKey } from "@repo/utils";

export interface HeroPlan { centered: boolean; minH: "screen" | "tall" }
export interface SectionPlan { key: DesignSectionKey; variant: string }
export interface RenderPlan { hero: HeroPlan; sections: SectionPlan[]; glow: boolean }

/** Map a normalized DesignSpec to layout options. 2b-1: every variant renders
 *  the single existing component; hero variants map to static align/height
 *  pairs; glow follows motif !== "none" (matches the archetype default feel).
 *  2b-2 swaps variant ids to real alternate components. */
export function composeRenderPlan(spec: DesignSpec): RenderPlan;
```

Behavior (exact):
- `hero`: `full-bleed` -> `{ centered: false, minH: "screen" }`; `split` -> `{ centered: false, minH: "screen" }`; `editorial` -> `{ centered: true, minH: "tall" }`; `minimal` -> `{ centered: true, minH: "tall" }`.
- `sections`: `spec.sections.filter(s => s.include).map(s => ({ key: s.key, variant: s.variant }))` — order preserved.
- `glow`: `spec.motif !== "none"`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { seedComposeDesignSpec, type DesignSpec } from "@repo/utils";
import { composeRenderPlan } from "./composePlan";

describe("composeRenderPlan", () => {
  const spec: DesignSpec = seedComposeDesignSpec("plan-shop");

  it("maps hero variants to the fixed align/height pairs", () => {
    expect(composeRenderPlan({ ...spec, hero: { variant: "full-bleed", motion: "none" } }).hero)
      .toEqual({ centered: false, minH: "screen" });
    expect(composeRenderPlan({ ...spec, hero: { variant: "editorial", motion: "none" } }).hero)
      .toEqual({ centered: true, minH: "tall" });
  });

  it("preserves section order and drops excluded sections", () => {
    const s: DesignSpec = {
      ...spec,
      sections: spec.sections.map((x) =>
        x.key === "team" ? { ...x, include: false } : x,
      ),
    };
    const plan = composeRenderPlan(s);
    expect(plan.sections.map((p) => p.key)).toEqual(
      s.sections.filter((x) => x.include).map((x) => x.key),
    );
    expect(plan.sections.some((p) => p.key === "team")).toBe(false);
  });

  it("glow follows the motif", () => {
    expect(composeRenderPlan({ ...spec, motif: "none" }).glow).toBe(false);
    expect(composeRenderPlan({ ...spec, motif: "arc" }).glow).toBe(true);
  });
});
```

- [ ] **Step 2: RED** — `cd apps/web && npx vitest run app/components/site/composePlan.test.ts` fails (module missing).
- [ ] **Step 3: Implement exactly the behavior above** (a ~20-line pure function).
- [ ] **Step 4: GREEN** — same command passes (3 tests).
- [ ] **Step 5: Commit** — `git add apps/web/app/components/site/composePlan.*` ; `git commit -m "feat(site): pure design_spec -> render plan mapping"`

---

### Task 4: Composer path inside CommercialTemplate + parity test

**Files:**
- Modify: `apps/web/app/components/CommercialTemplate.tsx`
- Test: `apps/web/app/components/site/renderParity.test.tsx`

**Interfaces:**
- Consumes: `normalizeDesignSpec`, `seedComposeDesignSpec`, `parseComposer` not needed; `composeRenderPlan` (Task 3); section components (Tasks 1-2); `SiteData.design_spec?: unknown` (arrives in Task 5 — for this task, read it via a local cast `(site as { design_spec?: unknown }).design_spec` and leave a one-line comment that Task 5 makes it a real field).
- Produces: v3 branch behavior —

```tsx
// After the archetype/ctx computation, before the return:
const rawSpec = (site as { design_spec?: unknown }).design_spec; // typed in SiteData by the plumbing task
let v3Plan: RenderPlan | null = null;
if ((site.design_version ?? 1) >= 3 && rawSpec && typeof rawSpec === "object") {
  // A stored spec is already normalized by the pipeline; normalize again on
  // read as belt-and-braces — a corrupt row falls back to the legacy path
  // rather than blanking the site.
  const { spec, fellBack } = normalizeDesignSpec(rawSpec, seedComposeDesignSpec(site.shop_id ?? "unknown"));
  v3Plan = fellBack.includes("all") ? null : composeRenderPlan(spec);
}
```

and in the returned JSX, when `v3Plan` is non-null render:

```tsx
<HeroSection ctx={ctx} centered={v3Plan.hero.centered} minH={v3Plan.hero.minH} />
{v3Plan.sections.map((p) => (
  <Fragment key={p.key}>{sections[p.key]}</Fragment>
))}
<FinalCtaSection ctx={ctx} glow={v3Plan.glow} />
```

with the `sections` Record built from plan-level options when `v3Plan` exists: `services` uses `cols={3}` and `glow={v3Plan.glow}`, `about` uses `pillarStyle="icons"`, `how` uses `stepsStyle="grid"` and `glow={v3Plan.glow}` (fixed 2b-1 defaults matching luxury-dark; 2b-2 derives them from `p.variant`). The legacy (v1/v2) path is the existing archetype-driven render, unchanged.

- [ ] **Step 1: Write the failing parity test**

`apps/web/app/components/site/renderParity.test.tsx`:

```tsx
/** Renders the legacy (v2/archetype) path and the v3 composer path with a
 *  spec that mirrors the luxury-dark archetype, and asserts byte-identical
 *  HTML. This is the 2b-1 contract: the composer is new machinery, not a new
 *  look. @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSpec } from "@repo/utils";

vi.mock("@remix-run/react", () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) => {
    const React = require("react");
    return React.createElement("a", { href: String(to), ...rest }, children as never);
  },
  useParams: () => ({ shopSlug: "parity-shop" }),
}));

import CommercialTemplate from "~/components/CommercialTemplate";

const baseSite = {
  shop_id: "parity-shop-id",
  shop_name: "Parity Barbers",
  headline: "Sharp cuts",
  tagline: "Walk out sharper",
  about: "Three sentences about the shop.",
  layout_mood: "luxury-dark",
  design_version: 2,
  trust_signals: ["500+ clients", "Walk-ins welcome", "5-star rated"],
  usps: ["Master barbers", "Easy booking", "Great coffee"],
  hero_cta: "Book Your Cut",
  about_title: "Why us",
};

/** Mirrors luxury-dark exactly: same order, all included, glow on. */
const mirrorSpec: DesignSpec = {
  composer: "ai",
  hero: { variant: "full-bleed", motion: "none" },
  sections: (["trust", "services", "about", "team", "how", "reviews", "location"] as const).map(
    (key) => ({ key, variant: "any", include: true }),
  ),
  motion: { intensity: "calm", reveal: "fade-up" },
  motif: "line",
  signature: null,
  density: "airy",
};

describe("v3 composer parity", () => {
  it("renders byte-identical HTML to the legacy path for a mirroring spec", () => {
    const services = [
      { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30 },
      { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20 },
    ];
    const legacy = renderToStaticMarkup(
      <CommercialTemplate site={{ ...baseSite }} services={services} />,
    );
    const v3 = renderToStaticMarkup(
      <CommercialTemplate
        site={{ ...baseSite, design_version: 3, design_spec: mirrorSpec } as never}
        services={services}
      />,
    );
    expect(v3).toBe(legacy);
  });
});
```

NOTE for the implementer: `mirrorSpec.sections[*].variant` is `"any"` on purpose — `normalizeDesignSpec` will repair it to a valid variant per key, and in 2b-1 the variant id does not influence rendering; if normalization changes the HTML, that IS a parity bug to fix. If `CommercialShopChrome` (rendered by the template) pulls in browser-only APIs that break under `renderToStaticMarkup`, mock `~/components/CommercialShopChrome` the same way (`({ children }) => <div>{children}</div>`) — parity is then asserted over the template body, which is the surface this PR changes; say so in your report.

- [ ] **Step 2: RED** — the v3 branch does not exist yet, so the second render takes the legacy path and the test PASSES vacuously. To make RED real: first implement ONLY the route branch skeleton returning a deliberately reordered plan (e.g. hard-code `sections.reverse()`), watch the test FAIL (proves it detects divergence), then implement the real mapping and watch it PASS. Record both runs in the report.
- [ ] **Step 3: Implement the v3 branch** exactly as the Interfaces block specifies.
- [ ] **Step 4: GREEN** — `cd apps/web && npx vitest run` all green (incl. the parity test); `npx tsc`; `npm run build`.
- [ ] **Step 5: Commit** — `git add apps/web/app/components/CommercialTemplate.tsx apps/web/app/components/site/renderParity.test.tsx` ; `git commit -m "feat(site): design_spec composer path with HTML parity test"`

---

### Task 5: Plumb design_spec worker -> loader -> SiteData

**Files:**
- Modify: `apps/worker/src/routes/shops.ts` — the `/site` endpoint's `designIntent` object (~lines 213-227)
- Modify: `apps/web/app/routes/$shopSlug.tsx` — `ShopSiteData` type (add `design_spec?: unknown`)
- Modify: `apps/web/app/routes/$shopSlug._index.tsx` — the `siteData` mapping (add the field)
- Modify: `apps/web/app/components/commercialSiteTypes.ts` — `SiteData` gains the real field; remove Task 4's local cast in `CommercialTemplate.tsx`
- Test: extend `apps/worker/test/` — the existing site-endpoint test file if one exists (grep `"/site"` under `apps/worker/test/`), else create `apps/worker/test/site-design-spec.test.ts`

**Interfaces:**
- Produces: `GET /api/shops/:shopId/site` response `data` gains `design_spec: unknown | null` (parsed from the TEXT column via `safeJsonParse`); `SiteData.design_spec?: unknown`.

- [ ] **Step 1: Write the failing worker test** — seed a shop + `shop_sites` row whose `design_spec` column holds `JSON.stringify(seedComposeDesignSpec("site-spec-shop"))` and `design_version = 3` (insert directly with `env.DB` following the idioms of the neighboring shops-route tests), then `GET /api/shops/<slug>/site` and assert `body.data.design_spec.hero.variant` is a string and `body.data.design_version` is 3. Second case: a row with `design_spec = NULL` returns `design_spec: null`.
- [ ] **Step 2: RED** — run the new test file; the field is absent (`undefined`), assertions fail.
- [ ] **Step 3: Implement** — in the `/site` endpoint: add `design_spec?: string | null;` to the `siteExtra` cast and `design_spec: safeJsonParse<unknown>(siteExtra.design_spec ?? undefined) ?? null,` to `designIntent`; add `design_spec?: unknown;` to `SiteData` (with a doc comment pointing at `@repo/utils` `DesignSpec`) and to `ShopSiteData`; map it in `$shopSlug._index.tsx`'s `siteData` literal as `design_spec: s.design_spec ?? undefined,`; replace Task 4's cast in `CommercialTemplate.tsx` with the typed field.
- [ ] **Step 4: GREEN + full suites** — `cd apps/worker && npx vitest run <new test file> && npm test`; `cd apps/web && npx tsc && npx vitest run && npm run build`. Check no stale `.js` twins for the two `$shopSlug` routes.
- [ ] **Step 5: Commit** — `git commit -m "feat(site): expose design_spec through the site API into SiteData"` (add the five files).

---

### Task 6: Full verification and PR

- [ ] **Step 1: Battery**

```bash
cd "F:\Projects\Pivot Parlor\pivot-parlor" && npm test
cd apps/web && npx tsc && npm run build && npm run lint
cd ../worker && npx tsc --noEmit
```

- [ ] **Step 2: PR**

```bash
git push -u origin feat/design-v3-renderer
gh pr create --title "refactor(site): v3 renderer skeleton — section components + design_spec composer, HTML-parity-proven" --body "<summary: verbatim extraction, composer behind design_version>=3 + normalize guard, parity test byte-compares both paths, design_spec plumbed through /site; zero visual change (2b-2 ships the variants). 🤖 Generated with [Claude Code](https://claude.com/claude-code)>"
gh pr checks --watch
```

User merges. After merge: no worker hand-deploys needed (main worker rides CI; builder/research unchanged).

---

## Self-review notes (already applied)

- The parity test's vacuous-pass trap is called out with an explicit divergence-first RED protocol.
- Section options for the v3 path are pinned to luxury-dark defaults so the mirror spec parity holds; 2b-2 replaces them with variant-derived options.
- The Task 4 `as never` casts disappear in Task 5; ordering is deliberate so the parity test exists before the plumbing.
- `normalizeDesignSpec` on read guards against corrupt rows; full fallback renders legacy, not blank.
