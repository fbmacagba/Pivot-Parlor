# Site Design v3 — Variant Library + Motion + Signatures (2b-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give v3 sites their visual payload: 14 real variant components, a CSS-first motion system (reveal / marquee / parallax / count-up), motif accents, density, and signature sections — while the motion-off mirror spec stays byte-identical to the legacy render.

**Architecture:** All work is in `apps/web` (no worker, no migration — next migration number 045 is NOT consumed). `composeRenderPlan` grows from a layout stub into the real variant→component+options mapper; `CommercialTemplate`'s v3 branch dispatches per-variant components and wraps sections in a `Reveal` wrapper (only when motion is on). New variants put copy on the page surface with ink tokens (so light palettes finally get light heroes), and each site gets at most one signature "wow" block rendered immediately before the final CTA.

**Tech Stack:** React 18 + Remix (Cloudflare Pages), Tailwind with `--st-*` theme tokens, vitest + jsdom (`renderToStaticMarkup` for DOM assertions), no new dependencies.

## Global Constraints

- Branch: `feat/design-v3-variants` off `main` (3e24d1d). Never commit to main. User merges the PR.
- **DO NOT touch `packages/utils/src/designSpec.ts`** — it has a byte-compare-guarded SYNC copy in `apps/workers/research/src/design-spec.ts` and golden-pinned seed output. 2b-2 consumes its types only.
- **Byte parity:** the parity test's mirror spec (motion intensity `"off"`, hero motion `"none"`, legacy-matching variant ids) must render byte-identical HTML to the legacy luxury-dark path. This is the moved parity anchor; calm/lively legitimately diverge (reveal wrappers).
- Colors ONLY via `--st-*` / `--color-brand` / `--color-accent` tokens. Exceptions allowed (matching existing practice): black scrims over photos (`from-black/55` etc.) and literal white text over photo scrims.
- Secondary text: never below `--st-ink-50` for meaningful text (WS-9 AA floor); `ink-25`/decorative alphas for decoration only.
- Touch targets >= 44px: `min-h-11` minimum on every link/button.
- No em-dashes in user-facing product text (copy uses `·` separators; code comments are exempt).
- No new npm dependencies. Motion is CSS + hooks.
- `vi.mock` factories must use async `await import()`, never `require()` (lint zero-warnings).
- Money display only via `formatPrice(svc.price_gbp)` (site-pipeline display boundary, WS-4 compliant). Never invent ratings/counts — social-proof numbers render only when `ctx.hasSocialProof`.
- Lint: `npm run lint` in apps/web must pass with zero warnings; `npx tsc` clean.
- Tests run from `apps/web`: `npx vitest run <file>`. Full suite: `npx vitest run`.
- Density affects ONLY new variants' internal spacing (existing sections ignore it — documented parity-safe limitation). Motif decor appears ONLY in new heroes + signature sections.

## File Structure

```
apps/web/app/components/site/
  composePlan.ts                 MODIFY  (Task 1 typing; Task 3 = v2 plan shape)
  composePlan.test.ts            MODIFY  (Tasks 1, 3)
  renderParity.test.tsx          MODIFY  (Tasks 1, 3: parity anchor moves to motion-off)
  testCtx.ts                     CREATE  (Task 4: shared SiteRenderContext builder for tests)
  seededSweep.test.tsx           CREATE  (Task 10)
  motion/
    motion.css                   CREATE  (Task 2: reveal/stagger/marquee/hero-fade + reduced-motion kill)
    useReveal.ts                 CREATE  (Task 2: shared IntersectionObserver)
    Reveal.tsx                   CREATE  (Task 2: wrapper; renders children unwrapped when disabled)
    reveal.test.tsx              CREATE  (Task 2)
    useParallax.ts               CREATE  (Task 4: rAF scroll drift, gated)
    useCountUp.ts                CREATE  (Task 9: stat count-up on first view)
  sections/
    bits.tsx                     MODIFY  (Task 4: + MotifDecor, sectionPadY)
    HeroSection.tsx              MODIFY  (Task 4: optional motionClass/parallax props, parity-safe)
    HeroSplitSection.tsx         CREATE  (Task 4)
    HeroEditorialSection.tsx     CREATE  (Task 4)
    HeroMinimalSection.tsx       CREATE  (Task 4)
    heroVariants.test.tsx        CREATE  (Task 4)
    TrustChipsSection.tsx        CREATE  (Task 5)
    TeamStripSection.tsx         CREATE  (Task 5)
    LocationMapFirstSection.tsx  CREATE  (Task 5)
    smallVariants.test.tsx       CREATE  (Task 5)
    ServicesRowsSection.tsx      CREATE  (Task 6)
    ServicesShowcaseSection.tsx  CREATE  (Task 6)
    servicesVariants.test.tsx    CREATE  (Task 6)
    AboutSplitImageSection.tsx   CREATE  (Task 7)
    AboutStorySection.tsx        CREATE  (Task 7)
    aboutVariants.test.tsx       CREATE  (Task 7)
    ReviewsMarqueeSection.tsx    CREATE  (Task 8)
    ReviewsSpotlightSection.tsx  CREATE  (Task 8)
    reviewsVariants.test.tsx     CREATE  (Task 8)
    SignatureGallerySection.tsx  CREATE  (Task 9)
    SignatureSpotlightSection.tsx CREATE (Task 9)
    signatures.test.tsx          CREATE  (Task 9)
apps/web/app/components/CommercialTemplate.tsx  MODIFY  (Tasks 3-9: v3 dispatch)
```

Design rationale (locked in the 2026-07-19 brainstorm + this plan): new heroes move copy off the photo scrim onto the page surface — the single biggest structural differentiator vs the current template, and it makes light-palette shops actually look light. ServicesRows is the barbershop wall price list (dotted leaders); TeamStrip is a thumb-scrollable rail; the signature section is each site's one bold moment (gallery look-book / review marquee / featured-service spotlight) and everything around it stays quiet. When `signature === "marquee-reviews"`, the middle reviews section is dropped from the plan (the signature IS the reviews block; rendering both would repeat the same six quotes).

---

### Task 1: 2b-1 debt cleanup (typing + tests)

**Files:**
- Modify: `apps/web/app/components/site/composePlan.ts`
- Modify: `apps/web/app/components/site/composePlan.test.ts`
- Modify: `apps/web/app/components/site/renderParity.test.tsx`

**Interfaces:**
- Consumes: `composeRenderPlan(spec: DesignSpec): RenderPlan` (2b-1 shape), `CommercialTemplate` props.
- Produces: `HERO_LAYOUTS: Record<HeroVariant, HeroPlan>` (exhaustive map, no `||` fallback); parity test's `baseSite` typed `SiteData` (no `as never`); a non-mirroring DOM test proving exclusion + reorder.

- [ ] **Step 1: Commit this plan document**

```powershell
git checkout -b feat/design-v3-variants
git add docs/superpowers/plans/2026-07-19-design-variants.md
git commit -m "docs(plan): 2b-2 variant library + motion + signatures plan"
```

- [ ] **Step 2: Write the failing tests** — in `composePlan.test.ts`, extend the hero-map test:

```ts
  it("maps hero variants to the fixed align/height pairs", () => {
    expect(composeRenderPlan({ ...spec, hero: { variant: "full-bleed", motion: "none" } }).hero)
      .toEqual({ centered: false, minH: "screen" });
    expect(composeRenderPlan({ ...spec, hero: { variant: "split", motion: "none" } }).hero)
      .toEqual({ centered: false, minH: "screen" });
    expect(composeRenderPlan({ ...spec, hero: { variant: "editorial", motion: "none" } }).hero)
      .toEqual({ centered: true, minH: "tall" });
    expect(composeRenderPlan({ ...spec, hero: { variant: "minimal", motion: "none" } }).hero)
      .toEqual({ centered: true, minH: "tall" });
  });
```

In `renderParity.test.tsx`: type `baseSite` as `SiteData` (`import type { SiteData } from "~/components/commercialSiteTypes";`, declare `const baseSite: SiteData = { ... }` unchanged fields), remove the `as never` cast from the v3 render, hoist `services` to describe scope, and add:

```tsx
  it("honours exclusion and reordering for a non-mirroring spec", () => {
    const spec: DesignSpec = {
      ...mirrorSpec,
      sections: [
        { key: "trust", variant: "icons", include: true },
        { key: "services", variant: "grid", include: true },
        { key: "reviews", variant: "cards", include: true },
        { key: "about", variant: "standard", include: true },
        { key: "team", variant: "cards", include: false },
        { key: "how", variant: "grid", include: true },
        { key: "location", variant: "standard", include: true },
      ],
    };
    const html = renderToStaticMarkup(
      <CommercialTemplate
        site={{ ...baseSite, design_version: 3, design_spec: spec }}
        services={services}
        staff={[{ id: "st1", display_name: "Alex Doe" }]}
        reviews={[{ id: "r1", customer_name: "Sam", rating: 5, body: "Great cut.", created_at: "2026-01-05T10:00:00Z" }]}
      />,
    );
    expect(html).not.toContain("Meet the team");
    expect(html.indexOf("Great cut.")).toBeGreaterThan(-1);
    expect(html.indexOf("Great cut.")).toBeLessThan(html.indexOf("Why us"));
  });
```

(Keep `mirrorSpec` itself untouched in this task — Task 3 moves the anchor.)

- [ ] **Step 3: Run tests** — `npx vitest run app/components/site` from `apps/web`. Expected: the new hero-map assertions PASS already (the 2b-1 map covers all four); the DOM test should PASS too (2b-1 filter/order logic). This task's failure mode is type-level: if removing `as never` errors, fix the `baseSite` literal until `npx tsc` is clean — do NOT reintroduce the cast.

- [ ] **Step 4: Tighten the map typing** — in `composePlan.ts` replace the inline map + fallback:

```ts
import type { DesignSpec, DesignSectionKey, HeroVariant } from "@repo/utils";
```

```ts
const HERO_LAYOUTS: Record<HeroVariant, HeroPlan> = {
  "full-bleed": { centered: false, minH: "screen" },
  split: { centered: false, minH: "screen" },
  editorial: { centered: true, minH: "tall" },
  minimal: { centered: true, minH: "tall" },
};

export function composeRenderPlan(spec: DesignSpec): RenderPlan {
  return {
    hero: HERO_LAYOUTS[spec.hero.variant],
    sections: spec.sections
      .filter((s) => s.include)
      .map((s) => ({ key: s.key, variant: s.variant })),
    glow: spec.motif !== "none",
  };
}
```

- [ ] **Step 5: Verify** — `npx vitest run app/components/site && npx tsc` from `apps/web`. Expected: all PASS, tsc clean.

- [ ] **Step 6: Commit**

```powershell
git add apps/web/app/components/site
git commit -m "refactor(site): exhaustive hero map typing + 2b-1 test debts"
```

---

### Task 2: Motion core (motion.css + useReveal + Reveal)

**Files:**
- Create: `apps/web/app/components/site/motion/motion.css`
- Create: `apps/web/app/components/site/motion/useReveal.ts`
- Create: `apps/web/app/components/site/motion/Reveal.tsx`
- Create: `apps/web/app/components/site/motion/reveal.test.tsx`

**Interfaces:**
- Produces: `useReveal(enabled: boolean): RefObject<HTMLDivElement | null>`; `<Reveal enabled style index lively>{children}</Reveal>` — when `enabled` is false renders `<>{children}</>` (NO wrapper element, byte-parity guarantee); CSS classes `st-reveal-wrap`, `st-reveal`, `st-reveal--fade-up|scale|slide`, `is-revealed`, `st-motion-calm|lively`, `st-hero-fade`, `st-marquee`, `st-marquee-track`.
- Consumed by: Tasks 3 (template wiring), 4 (hero fade), 8 (marquee).

- [ ] **Step 1: Write the failing test** — `reveal.test.tsx`:

```tsx
/** Reveal wrapper: hidden state is JS-applied only (no-JS visitors always see
 *  content); disabled renders children with no wrapper at all. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { Reveal } from "./Reveal";

type Entry = { isIntersecting: boolean; target: Element };
let ioCallback: ((entries: Entry[]) => void) | null = null;
const unobserved: Element[] = [];

class MockIntersectionObserver {
  constructor(cb: (entries: Entry[]) => void) {
    ioCallback = cb;
  }
  observe() {}
  unobserve(el: Element) {
    unobserved.push(el);
  }
  disconnect() {}
}

describe("Reveal", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    ioCallback = null;
    unobserved.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders children with no wrapper when disabled", () => {
    const child = <section id="x">hi</section>;
    expect(
      renderToStaticMarkup(
        <Reveal enabled={false} style="fade-up" index={0} lively={false}>{child}</Reveal>,
      ),
    ).toBe(renderToStaticMarkup(child));
  });

  it("SSR markup never contains the hidden state", () => {
    const html = renderToStaticMarkup(
      <Reveal enabled style="fade-up" index={0} lively={false}><section /></Reveal>,
    );
    expect(html).toContain('class="st-reveal-wrap st-reveal--fade-up"');
  });

  it("hides via JS on mount, reveals on intersection", () => {
    root = createRoot(container);
    act(() => {
      root!.render(
        <Reveal enabled style="scale" index={0} lively={false}><section /></Reveal>,
      );
    });
    const el = container.querySelector(".st-reveal-wrap")!;
    expect(el.classList.contains("st-reveal")).toBe(true);
    expect(el.classList.contains("is-revealed")).toBe(false);
    act(() => {
      ioCallback!([{ isIntersecting: true, target: el }]);
    });
    expect(el.classList.contains("is-revealed")).toBe(true);
    expect(unobserved).toContain(el);
  });

  it("staggers only when lively", () => {
    const lively = renderToStaticMarkup(
      <Reveal enabled style="fade-up" index={2} lively><section /></Reveal>,
    );
    const calm = renderToStaticMarkup(
      <Reveal enabled style="fade-up" index={2} lively={false}><section /></Reveal>,
    );
    expect(lively).toContain("--st-reveal-delay:180ms");
    expect(calm).toContain("--st-reveal-delay:0ms");
  });
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run app/components/site/motion/reveal.test.tsx`. Expected: FAIL (Reveal not found).

- [ ] **Step 3: Implement** — `useReveal.ts`:

```ts
import { useEffect, useRef } from "react";

let sharedObserver: IntersectionObserver | null = null;
const onReveal = new WeakMap<Element, () => void>();

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          onReveal.get(entry.target)?.();
          onReveal.delete(entry.target);
          sharedObserver?.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
  }
  return sharedObserver;
}

/** One shared IntersectionObserver for every reveal on the page. The hidden
 *  state (.st-reveal) is added only from this effect — never in SSR markup —
 *  so no-JS visitors always see content. Revealed once, then unobserved. */
export function useReveal(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const observer = getObserver();
    if (!observer) {
      el.classList.add("is-revealed");
      return;
    }
    el.classList.add("st-reveal");
    onReveal.set(el, () => el.classList.add("is-revealed"));
    observer.observe(el);
    return () => {
      onReveal.delete(el);
      observer.unobserve(el);
    };
  }, [enabled]);
  return ref;
}
```

`Reveal.tsx`:

```tsx
import type { CSSProperties, ReactNode } from "react";
import type { RevealStyle } from "@repo/utils";
import { useReveal } from "./useReveal";

/** Scroll-reveal wrapper for v3 sections. `enabled` false renders children
 *  with no wrapper at all, keeping the motion-off path byte-identical to an
 *  unwrapped render. Stagger applies only on "lively" (capped at 6 steps). */
export function Reveal({
  enabled,
  style,
  index,
  lively,
  children,
}: {
  enabled: boolean;
  style: RevealStyle;
  index: number;
  lively: boolean;
  children: ReactNode;
}) {
  const ref = useReveal(enabled);
  if (!enabled) return <>{children}</>;
  const delay = lively ? `${Math.min(index, 6) * 90}ms` : "0ms";
  return (
    <div
      ref={ref}
      className={`st-reveal-wrap st-reveal--${style}`}
      style={{ "--st-reveal-delay": delay } as CSSProperties}
    >
      {children}
    </div>
  );
}
```

`motion.css`:

```css
/* Site Design v3 motion (2b-2). The hidden state (.st-reveal) is added only
   by JS after hydration, so no-JS visitors always see every section. Reduced
   motion kills all movement at the stylesheet level. */

.st-reveal {
  opacity: 0;
  transition:
    opacity var(--st-reveal-dur, 600ms) ease-out var(--st-reveal-delay, 0ms),
    transform var(--st-reveal-dur, 600ms) ease-out var(--st-reveal-delay, 0ms);
}
.st-reveal.st-reveal--fade-up {
  transform: translateY(var(--st-reveal-dist, 20px));
}
.st-reveal.st-reveal--scale {
  transform: scale(0.96);
}
.st-reveal.st-reveal--slide {
  transform: translateX(calc(var(--st-reveal-dist, 20px) * -1));
}
.st-reveal.is-revealed {
  opacity: 1;
  transform: none;
}

/* Intensity scopes set the distance/duration the reveal transitions read. */
.st-motion-calm {
  --st-reveal-dist: 14px;
  --st-reveal-dur: 500ms;
}
.st-motion-lively {
  --st-reveal-dist: 26px;
  --st-reveal-dur: 650ms;
}

/* Hero load-in (hero.motion "fade"). */
@keyframes st-hero-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.st-hero-fade {
  animation: st-hero-fade 700ms ease-out both;
}

/* Reviews marquee: the track holds the card list twice; shifting half the
   track width loops seamlessly. Hover or keyboard focus pauses it. */
@keyframes st-marquee {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
.st-marquee-track {
  animation: st-marquee var(--st-marquee-dur, 45s) linear infinite;
}
.st-marquee:hover .st-marquee-track,
.st-marquee:focus-within .st-marquee-track {
  animation-play-state: paused;
}

@media (prefers-reduced-motion: reduce) {
  .st-reveal {
    opacity: 1;
    transform: none;
    transition: none;
  }
  .st-hero-fade {
    animation: none;
  }
  .st-marquee-track {
    animation: none;
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run app/components/site/motion/reveal.test.tsx`. Expected: 4 PASS. (If the stagger assertion fails on style serialization, check React's actual output with a quick `console.log` — React renders custom properties as `--st-reveal-delay:180ms` in static markup; adjust the assertion to `toContain("180ms")` if formatting differs.)

- [ ] **Step 5: Commit**

```powershell
git add apps/web/app/components/site/motion
git commit -m "feat(site): v3 motion core - reveal observer, wrapper, motion.css"
```

---

### Task 3: composePlan v2 + template v3 wiring + parity anchor move

**Files:**
- Modify: `apps/web/app/components/site/composePlan.ts`
- Modify: `apps/web/app/components/site/composePlan.test.ts`
- Modify: `apps/web/app/components/CommercialTemplate.tsx`
- Modify: `apps/web/app/components/site/renderParity.test.tsx`

**Interfaces:**
- Consumes: `Reveal` from Task 2; `DesignSpec` enums from `@repo/utils`.
- Produces (later tasks rely on these exact shapes):

```ts
export interface HeroPlan {
  variant: HeroVariant;
  motion: HeroMotion;       // forced "none" when reveal is null
  centered: boolean;
  minH: "screen" | "tall";
}
export interface SectionPlan { key: DesignSectionKey; variant: string }
export interface RevealPlan { style: RevealStyle; intensity: "calm" | "lively" }
export interface RenderPlan {
  hero: HeroPlan;
  sections: SectionPlan[];
  signature: SignatureId | null;
  glow: boolean;
  motif: Motif;
  density: Density;
  reveal: RevealPlan | null;  // null when motion.intensity is "off"
}
```

Also produces the template-side dispatch `v3SectionNode(key, variant, plan)` that Tasks 4-9 extend arm by arm, and `sectionHasContent(key)` so null sections are never wrapped in an animating div.

- [ ] **Step 1: Write the failing tests** — replace/extend `composePlan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { seedComposeDesignSpec, type DesignSpec } from "@repo/utils";
import { composeRenderPlan } from "./composePlan";

describe("composeRenderPlan", () => {
  const spec: DesignSpec = seedComposeDesignSpec("plan-shop");

  it("maps hero variants to the fixed align/height pairs", () => {
    const h = (variant: DesignSpec["hero"]["variant"]) =>
      composeRenderPlan({ ...spec, hero: { variant, motion: "none" } }).hero;
    expect(h("full-bleed")).toMatchObject({ centered: false, minH: "screen" });
    expect(h("split")).toMatchObject({ centered: false, minH: "screen" });
    expect(h("editorial")).toMatchObject({ centered: true, minH: "tall" });
    expect(h("minimal")).toMatchObject({ centered: true, minH: "tall" });
  });

  it("preserves section order and drops excluded sections", () => {
    const s: DesignSpec = {
      ...spec,
      signature: "gallery",
      sections: spec.sections.map((x) => (x.key === "team" ? { ...x, include: false } : x)),
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

  it("motion off yields a null reveal and forces hero motion to none", () => {
    const off = composeRenderPlan({
      ...spec,
      hero: { variant: "split", motion: "parallax" },
      motion: { intensity: "off", reveal: "scale" },
    });
    expect(off.reveal).toBeNull();
    expect(off.hero.motion).toBe("none");
    const calm = composeRenderPlan({
      ...spec,
      hero: { variant: "split", motion: "parallax" },
      motion: { intensity: "calm", reveal: "scale" },
    });
    expect(calm.reveal).toEqual({ style: "scale", intensity: "calm" });
    expect(calm.hero.motion).toBe("parallax");
  });

  it("passes signature, motif and density through", () => {
    const p = composeRenderPlan({ ...spec, signature: "spotlight", motif: "arc", density: "compact" });
    expect(p.signature).toBe("spotlight");
    expect(p.motif).toBe("arc");
    expect(p.density).toBe("compact");
  });

  it("drops the middle reviews section when the signature is marquee-reviews", () => {
    const p = composeRenderPlan({ ...spec, signature: "marquee-reviews" });
    expect(p.sections.some((s) => s.key === "reviews")).toBe(false);
    const q = composeRenderPlan({ ...spec, signature: "gallery" });
    expect(q.sections.some((s) => s.key === "reviews")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run app/components/site/composePlan.test.ts`. Expected: FAIL (reveal/signature fields missing).

- [ ] **Step 3: Implement composePlan v2** — full new `composePlan.ts`:

```ts
import type {
  DesignSpec,
  DesignSectionKey,
  Density,
  HeroMotion,
  HeroVariant,
  Motif,
  RevealStyle,
  SignatureId,
} from "@repo/utils";

export interface HeroPlan {
  variant: HeroVariant;
  motion: HeroMotion;
  centered: boolean;
  minH: "screen" | "tall";
}

export interface SectionPlan {
  key: DesignSectionKey;
  variant: string;
}

export interface RevealPlan {
  style: RevealStyle;
  intensity: "calm" | "lively";
}

export interface RenderPlan {
  hero: HeroPlan;
  sections: SectionPlan[];
  signature: SignatureId | null;
  glow: boolean;
  motif: Motif;
  density: Density;
  /** null when motion.intensity is "off": no wrappers, no hero motion, static marquee. */
  reveal: RevealPlan | null;
}

const HERO_LAYOUTS: Record<HeroVariant, Pick<HeroPlan, "centered" | "minH">> = {
  "full-bleed": { centered: false, minH: "screen" },
  split: { centered: false, minH: "screen" },
  editorial: { centered: true, minH: "tall" },
  minimal: { centered: true, minH: "tall" },
};

/** Map a normalized DesignSpec to the render plan the v3 template consumes.
 *  Variant ids are trusted (normalizeDesignSpec already constrained them to
 *  the SECTION_VARIANTS pools); unknown ids fall back to each section's
 *  standard component at the dispatch site. */
export function composeRenderPlan(spec: DesignSpec): RenderPlan {
  const reveal: RevealPlan | null =
    spec.motion.intensity === "off"
      ? null
      : { style: spec.motion.reveal, intensity: spec.motion.intensity };
  return {
    hero: {
      variant: spec.hero.variant,
      motion: reveal ? spec.hero.motion : "none",
      ...HERO_LAYOUTS[spec.hero.variant],
    },
    sections: spec.sections
      .filter((s) => s.include)
      // The marquee-reviews signature IS the reviews block; rendering the
      // middle reviews section too would repeat the same six quotes.
      .filter((s) => !(spec.signature === "marquee-reviews" && s.key === "reviews"))
      .map((s) => ({ key: s.key, variant: s.variant })),
    signature: spec.signature,
    glow: spec.motif !== "none",
    motif: spec.motif,
    density: spec.density,
    reveal,
  };
}
```

- [ ] **Step 4: Run** — `npx vitest run app/components/site/composePlan.test.ts`. Expected: 6 PASS. (`renderParity` will fail to compile until Step 5 — fine.)

- [ ] **Step 5: Wire the template** — in `CommercialTemplate.tsx`:

Add imports:

```tsx
import { Reveal } from "~/components/site/motion/Reveal";
import "~/components/site/motion/motion.css";
```

Simplify the legacy `sections` record (v3 no longer reads it — remove the `v3Plan ?` ternaries):

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

Add the v3 dispatch + visibility helpers (after `ctx` is built, before `return`):

```tsx
  // v3 dispatch: variant -> component + options. Alternate variants land in
  // 2b-2 tasks 4-9; until then every id renders the section's standard
  // component. The "how" variants already exist as stepsStyle.
  const v3SectionNode = (key: SectionKey, variant: string, plan: RenderPlan): ReactNode => {
    switch (key) {
      case "trust":
        return <TrustSection ctx={ctx} />;
      case "services":
        return <ServicesSection ctx={ctx} cols={3} glow={plan.glow} />;
      case "about":
        return <AboutSection ctx={ctx} pillarStyle="icons" />;
      case "team":
        return <TeamSection ctx={ctx} />;
      case "how":
        return <HowSection ctx={ctx} stepsStyle={variant === "row" ? "row" : "grid"} glow={plan.glow} />;
      case "reviews":
        return <ReviewsSection ctx={ctx} />;
      case "location":
        return <LocationSection ctx={ctx} />;
    }
  };

  // A wrapped-but-empty reveal div would still animate; skip sections that
  // will render null (same conditions the components enforce internally).
  const sectionHasContent = (key: SectionKey): boolean =>
    key === "team"
      ? staff.length > 0
      : key === "reviews"
        ? sortedReviews.length > 0
        : key === "location"
          ? hasAddress
          : true;
```

Replace the v3 branch of the return:

```tsx
      {v3Plan ? (
        (() => {
          const plan = v3Plan;
          const visible = plan.sections.filter((p) => sectionHasContent(p.key));
          const enabled = plan.reveal !== null;
          const lively = plan.reveal?.intensity === "lively";
          const style = plan.reveal?.style ?? "fade-up";
          const body = (
            <>
              <HeroSection ctx={ctx} centered={plan.hero.centered} minH={plan.hero.minH} />
              {visible.map((p, i) => (
                <Reveal key={p.key} enabled={enabled} style={style} index={i} lively={lively}>
                  {v3SectionNode(p.key, p.variant, plan)}
                </Reveal>
              ))}
              <Reveal enabled={enabled} style={style} index={visible.length} lively={lively}>
                <FinalCtaSection ctx={ctx} glow={plan.glow} />
              </Reveal>
            </>
          );
          return plan.reveal ? (
            <div className={`st-motion-${plan.reveal.intensity}`}>{body}</div>
          ) : (
            body
          );
        })()
      ) : (
        <>
          <HeroSection ctx={ctx} centered={heroCentered} minH={archetype.heroMinH} />
          {/* Middle sections in the archetype's order */}
          {archetype.order.map((key) => (
            <Fragment key={key}>{sections[key]}</Fragment>
          ))}
          <FinalCtaSection ctx={ctx} glow={archetype.glow} />
        </>
      )}
```

- [ ] **Step 6: Move the parity anchor** — in `renderParity.test.tsx`, replace `mirrorSpec` with the motion-off, legacy-variant mirror and add the divergence test:

```tsx
/** Mirrors luxury-dark exactly with motion OFF: same order, all included,
 *  legacy-matching variants, glow on (motif line), no signature. This is the
 *  2b-2 parity anchor: v3-with-motion-off === legacy, byte for byte. */
const mirrorSpec: DesignSpec = {
  composer: "ai",
  hero: { variant: "full-bleed", motion: "none" },
  sections: [
    { key: "trust", variant: "icons", include: true },
    { key: "services", variant: "grid", include: true },
    { key: "about", variant: "standard", include: true },
    { key: "team", variant: "cards", include: true },
    { key: "how", variant: "grid", include: true },
    { key: "reviews", variant: "cards", include: true },
    { key: "location", variant: "standard", include: true },
  ],
  motion: { intensity: "off", reveal: "fade-up" },
  motif: "line",
  signature: null,
  density: "airy",
};
```

```tsx
  it("wraps sections in reveal wrappers when motion is on", () => {
    const calm: DesignSpec = { ...mirrorSpec, motion: { intensity: "calm", reveal: "fade-up" } };
    const html = renderToStaticMarkup(
      <CommercialTemplate
        site={{ ...baseSite, design_version: 3, design_spec: calm }}
        services={services}
      />,
    );
    expect(html).toContain("st-motion-calm");
    expect(html).toContain('class="st-reveal-wrap st-reveal--fade-up"');
  });
```

- [ ] **Step 7: Verify parity + suite** — `npx vitest run app/components/site && npx tsc` from `apps/web`. Expected: ALL PASS — the byte-parity test is the gate; if it fails, diff the two HTML strings (write both to files and compare) and fix the v3 path, never the legacy path.

- [ ] **Step 8: Commit**

```powershell
git add apps/web/app/components
git commit -m "feat(site): composePlan v2 - reveal wiring, signature plumbing, parity anchor at motion-off"
```

---

### Task 4: Hero variants (Split / Editorial / Minimal) + MotifDecor + useParallax

**Files:**
- Create: `apps/web/app/components/site/motion/useParallax.ts`
- Modify: `apps/web/app/components/site/sections/bits.tsx` (add `MotifDecor`, `sectionPadY`)
- Modify: `apps/web/app/components/site/sections/HeroSection.tsx` (optional `motionClass`/`parallax` props)
- Create: `apps/web/app/components/site/sections/HeroSplitSection.tsx`
- Create: `apps/web/app/components/site/sections/HeroEditorialSection.tsx`
- Create: `apps/web/app/components/site/sections/HeroMinimalSection.tsx`
- Create: `apps/web/app/components/site/testCtx.ts`
- Create: `apps/web/app/components/site/sections/heroVariants.test.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx` (v3 hero dispatch)

**Interfaces:**
- Consumes: `RenderPlan` (Task 3), motion.css classes (Task 2).
- Produces: `useParallax<T extends HTMLElement>(enabled: boolean, max?: number, baseTransform?: string): RefObject<T | null>`; `MotifDecor({ motif, className })`; `sectionPadY(density): string`; `makeTestCtx(overrides?): SiteRenderContext`; hero components with signature `{ ctx, density, motif, motionClass, parallax }` (`parallax` absent on Minimal). All later variant tasks use `makeTestCtx` and `sectionPadY`.

- [ ] **Step 1: Shared test context** — `testCtx.ts` (plain `.ts`; icons are `null`, a valid ReactNode):

```ts
import { archetypeFor } from "~/components/siteArchetype";
import type { SiteRenderContext } from "~/components/site/sectionContext";

/** Test-only SiteRenderContext builder for section-variant DOM tests. */
export function makeTestCtx(overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  const archetype = archetypeFor("luxury-dark");
  const services = [
    { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30, category: "Hair", description: "Classic cut and finish.", image_url: "https://img.example/one.jpg" },
    { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20, category: "Beard", image_url: "https://img.example/two.jpg" },
    { id: "s3", name: "Hot towel shave", price_gbp: 35, duration_minutes: 45, image_url: "https://img.example/three.jpg" },
  ];
  return {
    site: { shop_id: "test-shop-id", shop_name: "Test Shop", tagline: "Walk out sharper", design_version: 3, rating: 4.8, review_count: 12 },
    settings: { address: "1 High St, London", phone: "020 1234 5678" },
    shopSlug: "test-shop",
    services,
    filteredServices: services,
    categories: ["All", "Beard", "Hair"],
    category: "All",
    setCategory: () => {},
    staff: [
      { id: "st1", display_name: "Alex Doe", speciality: "Fades", bio: "Ten years on the chair." },
      { id: "st2", display_name: "Jo Bloggs" },
    ],
    sortedReviews: [
      { id: "r1", customer_name: "Sam", rating: 5, body: "Great cut, will be back.", created_at: "2026-01-05T10:00:00Z" },
      { id: "r2", customer_name: "Ash", rating: 4, body: "Friendly and quick.", created_at: "2026-01-04T10:00:00Z" },
    ],
    reviewCount: 12,
    hasAddress: true,
    hasSocialProof: true,
    statsHappy: "20+",
    statsRating: "4.8",
    trustSignals: ["Walk-ins welcome", "5-star rated"],
    heroSubline: "Walk-ins welcome · 5-star rated",
    heroHeadline: "Test Shop",
    heroTagline: "Walk out sharper",
    heroSrc: "https://img.example/hero.jpg",
    aboutText: "A neighbourhood shop with proper chairs.",
    aboutHeading: "Why us",
    bookLabel: "Book Now",
    pillars: [
      { title: "Expert Staff", icon: null },
      { title: "Easy Booking", icon: null },
      { title: "Guaranteed Satisfaction", icon: null },
    ],
    steps: archetype.steps.map((s, i) => ({ n: String(i + 1), t: s.t, d: s.d, icon: null })),
    archetype,
    scrollToId: () => {},
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests** — `heroVariants.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "test-shop" }),
  };
});

import { HeroSplitSection } from "./HeroSplitSection";
import { HeroEditorialSection } from "./HeroEditorialSection";
import { HeroMinimalSection } from "./HeroMinimalSection";

const ctx = makeTestCtx();

describe("hero variants", () => {
  it("split puts copy on the page surface beside the image", () => {
    const html = renderToStaticMarkup(
      <HeroSplitSection ctx={ctx} density="airy" motif="line" motionClass="" parallax={false} />,
    );
    expect(html).toContain("Test Shop");
    expect(html).toContain("hero.jpg");
    expect(html).not.toContain("from-black/85"); // no full-bleed scrim
    expect(html).toContain("--st-ink"); // ink tokens, not literal white
  });

  it("split falls back to a brand gradient without a hero image", () => {
    const html = renderToStaticMarkup(
      <HeroSplitSection ctx={makeTestCtx({ heroSrc: "" })} density="airy" motif="none" motionClass="" parallax={false} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("linear-gradient");
  });

  it("editorial renders the eyebrow and a wide image band below the type", () => {
    const html = renderToStaticMarkup(
      <HeroEditorialSection ctx={ctx} density="airy" motif="dot-grid" motionClass="" parallax={false} />,
    );
    expect(html).toContain("aspect-[21/9]");
    expect(html).toContain("uppercase");
    expect(html).toContain("Walk-ins welcome");
  });

  it("minimal never renders imagery", () => {
    const html = renderToStaticMarkup(
      <HeroMinimalSection ctx={ctx} density="airy" motif="arc" motionClass="st-hero-fade" />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("st-hero-fade");
    expect(html).toContain("Test Shop");
  });

  it("density tightens vertical padding", () => {
    const airy = renderToStaticMarkup(
      <HeroSplitSection ctx={ctx} density="airy" motif="none" motionClass="" parallax={false} />,
    );
    const compact = renderToStaticMarkup(
      <HeroSplitSection ctx={ctx} density="compact" motif="none" motionClass="" parallax={false} />,
    );
    expect(airy).not.toBe(compact);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run app/components/site/sections/heroVariants.test.tsx`. Expected: FAIL (modules missing).

- [ ] **Step 4: Implement `useParallax.ts`**

```ts
import { useEffect, useRef } from "react";

/** Slow scroll drift for hero/signature imagery: at most +-`max` px, driven
 *  by one passive scroll listener + rAF per host. `baseTransform` preserves a
 *  class-based transform (e.g. "scale(1.05)") the inline style would clobber.
 *  No-ops when disabled and under prefers-reduced-motion. */
export function useParallax<T extends HTMLElement>(
  enabled: boolean,
  max = 14,
  baseTransform = "",
) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = el.getBoundingClientRect();
        const vh = window.innerHeight || 1;
        const progress = Math.min(1, Math.max(-1, (rect.top + rect.height / 2 - vh / 2) / vh));
        el.style.transform = `${baseTransform} translateY(${(-progress * max).toFixed(1)}px)`.trim();
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      el.style.transform = "";
    };
  }, [enabled, max, baseTransform]);
  return ref;
}
```

- [ ] **Step 5: Add `MotifDecor` + `sectionPadY` to `bits.tsx`** (append; also add the type import):

```tsx
import type { Density, Motif } from "@repo/utils";
```

```tsx
/** Vertical rhythm for NEW v3 variants only (existing sections keep their
 *  hardcoded padding — parity). Callers add their own horizontal padding. */
export function sectionPadY(density: Density): string {
  return density === "compact" ? "py-12 md:py-16" : "py-16 md:py-24";
}

/** Decorative accent for new-variant heroes and signature sections only.
 *  "line" renders in-flow (caller places it, usually with w-fit/mb-*);
 *  "dot-grid" and "arc" are absolutely positioned via className. Always
 *  aria-hidden, always token colours. */
export function MotifDecor({ motif, className = "" }: { motif: Motif; className?: string }) {
  if (motif === "none") return null;
  if (motif === "line") {
    return (
      <span className={`pointer-events-none flex items-center gap-3 ${className}`} aria-hidden>
        <span className="h-px w-16 bg-[color:var(--st-accent-40)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--st-accent-40)]" />
      </span>
    );
  }
  if (motif === "dot-grid") {
    return (
      <span
        className={`pointer-events-none absolute h-40 w-40 ${className}`}
        style={{
          backgroundImage: "radial-gradient(var(--st-accent-25) 1.5px, transparent 1.5px)",
          backgroundSize: "14px 14px",
        }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className={`pointer-events-none absolute h-72 w-72 rounded-full border border-[color:var(--st-accent-15)] ${className}`}
      aria-hidden
    />
  );
}
```

- [ ] **Step 6: HeroSection optional props (parity-safe)** — signature becomes:

```tsx
export function HeroSection({
  ctx,
  centered,
  minH,
  motionClass = "",
  parallax = false,
}: {
  ctx: SiteRenderContext;
  centered: boolean;
  minH: "screen" | "tall";
  motionClass?: string;
  parallax?: boolean;
}) {
  const imgRef = useParallax<HTMLImageElement>(parallax, 14, "scale(1.05)");
  const minHClass = minH === "tall" ? "min-h-[85vh]" : "min-h-screen";
  return (
    <section className={`relative flex ${minHClass} flex-col overflow-hidden${motionClass ? ` ${motionClass}` : ""}`}>
```

…and the hero `<img` gains `ref={imgRef}` (attribute renders nothing — byte parity holds when the props are omitted). Import `useParallax` from `~/components/site/motion/useParallax`. Everything else stays verbatim.

- [ ] **Step 7: Implement `HeroSplitSection.tsx`**

```tsx
import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor, StarRow } from "~/components/site/sections/bits";
import { useParallax } from "~/components/site/motion/useParallax";

/** Hero "split": copy on the page surface beside a full-height image column,
 *  like a shopfront window next to the sign. Ink tokens, not white-on-scrim,
 *  so light palettes finally get a light hero. */
export function HeroSplitSection({
  ctx,
  density,
  motif,
  motionClass,
  parallax,
}: {
  ctx: SiteRenderContext;
  density: Density;
  motif: Motif;
  motionClass: string;
  parallax: boolean;
}) {
  const imgRef = useParallax<HTMLImageElement>(parallax, 14, "scale(1.05)");
  const pad = density === "compact" ? "py-14 md:py-16" : "py-20 md:py-24";
  return (
    <section className={`relative overflow-hidden${motionClass ? ` ${motionClass}` : ""}`}>
      <div className="grid w-full lg:grid-cols-2">
        <div className={`relative mx-auto flex w-full max-w-2xl flex-col justify-center px-4 ${pad} md:px-6 lg:min-h-screen lg:pl-[max(1.5rem,calc((100vw-80rem)/2))] lg:pr-16`}>
          {motif === "line" ? <MotifDecor motif="line" className="mb-6 w-fit" /> : <MotifDecor motif={motif} className="-left-10 bottom-8 opacity-70" />}
          <div className="inline-flex min-h-11 w-fit items-center gap-2 rounded-full border border-[color:var(--st-line-20)] bg-[color:var(--st-card-faint)] px-4 py-2 text-sm text-[color:var(--st-ink-90)]">
            {ctx.hasSocialProof ? (
              <>
                <StarRow rating={typeof ctx.site.rating === "number" ? ctx.site.rating : 5} className="text-sm" />
                <span>{ctx.statsRating}★ from {ctx.reviewCount} review{ctx.reviewCount === 1 ? "" : "s"}</span>
              </>
            ) : (
              <>
                <span className="text-[color:var(--st-accent-text)]" aria-hidden>✓</span>
                <span>Online booking · Instant confirmation</span>
              </>
            )}
          </div>
          <h1 className="mt-8 text-[clamp(2.5rem,5vw,4.25rem)] font-bold leading-[1.05] tracking-tight text-[color:var(--st-ink)]">
            {ctx.heroHeadline}
          </h1>
          {ctx.heroTagline ? (
            <h2 className="mt-4 max-w-xl text-[clamp(1.05rem,2vw,1.3rem)] font-light leading-relaxed text-[color:var(--st-ink-70)]">
              {ctx.heroTagline}
            </h2>
          ) : null}
          <div className="mt-10 flex flex-wrap gap-4">
            <Link to={`/${ctx.shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-shadow-25)] transition hover:brightness-110">
              {ctx.bookLabel} →
            </Link>
            <button type="button" onClick={() => ctx.scrollToId("services")}
              className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] border-2 border-[color:var(--st-line-40)] bg-transparent px-8 pp-heading text-base font-semibold text-[color:var(--st-ink)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--st-accent-text)]">
              See Our Services
            </button>
          </div>
          <p className="mt-8 text-sm text-[color:var(--st-ink-55)]">{ctx.heroSubline}</p>
        </div>
        <div className="relative min-h-[42vh] overflow-hidden lg:min-h-screen">
          {ctx.heroSrc ? (
            <>
              <img
                ref={imgRef}
                src={ctx.heroSrc}
                alt={`${ctx.site.shop_name} hero photo`}
                className="absolute inset-0 h-full w-full scale-105 object-cover"
                loading="eager"
                decoding="async"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[color:var(--st-bg)] via-transparent to-transparent lg:bg-gradient-to-r" aria-hidden />
            </>
          ) : (
            <div className="h-full min-h-[42vh] w-full lg:min-h-screen" style={{ background: "linear-gradient(145deg, var(--color-brand) 0%, var(--st-bg) 60%, var(--color-accent) 170%)" }} aria-hidden />
          )}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 8: Implement `HeroEditorialSection.tsx`**

```tsx
import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor } from "~/components/site/sections/bits";
import { useParallax } from "~/components/site/motion/useParallax";

/** Hero "editorial": a magazine opener — oversized centred display type on
 *  the page surface, the trust line as an eyebrow, and the image as a wide
 *  band BELOW the headline instead of behind it. */
export function HeroEditorialSection({
  ctx,
  density,
  motif,
  motionClass,
  parallax,
}: {
  ctx: SiteRenderContext;
  density: Density;
  motif: Motif;
  motionClass: string;
  parallax: boolean;
}) {
  const imgRef = useParallax<HTMLImageElement>(parallax, 10, "scale(1.05)");
  const pad = density === "compact" ? "pt-16 pb-12 md:pt-20 md:pb-16" : "pt-20 pb-16 md:pt-28 md:pb-24";
  return (
    <section className={`relative overflow-hidden px-4 md:px-6 ${pad}${motionClass ? ` ${motionClass}` : ""}`}>
      {motif !== "line" ? <MotifDecor motif={motif} className="-right-10 top-16" /> : null}
      <div className="relative mx-auto w-full max-w-5xl text-center">
        {motif === "line" ? <MotifDecor motif="line" className="mx-auto mb-8 w-fit" /> : null}
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-accent-text)]">
          {ctx.heroSubline}
        </p>
        <h1 className="mx-auto mt-6 max-w-4xl text-[clamp(2.75rem,8vw,5.5rem)] font-bold leading-[0.98] tracking-tight text-[color:var(--st-ink)]">
          {ctx.heroHeadline}
        </h1>
        {ctx.heroTagline ? (
          <h2 className="mx-auto mt-6 max-w-2xl text-[clamp(1.05rem,2.2vw,1.35rem)] font-light leading-relaxed text-[color:var(--st-ink-70)]">
            {ctx.heroTagline}
          </h2>
        ) : null}
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link to={`/${ctx.shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-shadow-25)] transition hover:brightness-110">
            {ctx.bookLabel} →
          </Link>
          <button type="button" onClick={() => ctx.scrollToId("services")}
            className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] border-2 border-[color:var(--st-line-40)] bg-transparent px-8 pp-heading text-base font-semibold text-[color:var(--st-ink)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--st-accent-text)]">
            See Our Services
          </button>
        </div>
      </div>
      {ctx.heroSrc ? (
        <div className="relative mx-auto mt-14 aspect-[21/9] w-full max-w-6xl overflow-hidden rounded-[var(--st-r-lg)]">
          <img
            ref={imgRef}
            src={ctx.heroSrc}
            alt={`${ctx.site.shop_name} hero photo`}
            className="absolute inset-0 h-full w-full scale-105 object-cover"
            loading="eager"
            decoding="async"
          />
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 9: Implement `HeroMinimalSection.tsx`**

```tsx
import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor } from "~/components/site/sections/bits";

/** Hero "minimal": no imagery at all — restraint is the statement. A faint
 *  accent wash, big type, one primary action and a quiet text link. */
export function HeroMinimalSection({
  ctx,
  density,
  motif,
  motionClass,
}: {
  ctx: SiteRenderContext;
  density: Density;
  motif: Motif;
  motionClass: string;
}) {
  const pad = density === "compact" ? "py-24 md:py-28" : "py-28 md:py-36";
  return (
    <section className={`relative flex min-h-[85vh] flex-col items-center justify-center overflow-hidden px-4 md:px-6 ${pad}${motionClass ? ` ${motionClass}` : ""}`}>
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--st-accent-07)] blur-3xl" aria-hidden />
      {motif !== "line" ? <MotifDecor motif={motif} className="right-[12%] top-[18%]" /> : null}
      <div className="relative mx-auto w-full max-w-3xl text-center">
        {motif === "line" ? <MotifDecor motif="line" className="mx-auto mb-10 w-fit" /> : null}
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-ink-55)]">{ctx.heroSubline}</p>
        <h1 className="mt-6 text-[clamp(2.75rem,7vw,5rem)] font-bold leading-[1.02] tracking-tight text-[color:var(--st-ink)]">
          {ctx.heroHeadline}
        </h1>
        {ctx.heroTagline ? (
          <h2 className="mx-auto mt-6 max-w-xl text-[clamp(1.05rem,2.2vw,1.3rem)] font-light leading-relaxed text-[color:var(--st-ink-70)]">
            {ctx.heroTagline}
          </h2>
        ) : null}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-5">
          <Link to={`/${ctx.shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-shadow-25)] transition hover:brightness-110">
            {ctx.bookLabel} →
          </Link>
          <button type="button" onClick={() => ctx.scrollToId("services")}
            className="inline-flex min-h-11 items-center pp-heading text-base font-semibold text-[color:var(--st-ink-80)] underline decoration-[color:var(--st-accent-40)] underline-offset-8 transition hover:text-[color:var(--st-accent-text)]">
            See Our Services
          </button>
        </div>
        <p className="mt-10 text-sm text-[color:var(--st-ink-55)]">Book in under a minute · No account needed</p>
      </div>
    </section>
  );
}
```

- [ ] **Step 10: Template hero dispatch** — in `CommercialTemplate.tsx` import the three heroes, add next to `v3SectionNode`:

```tsx
  const v3Hero = (plan: RenderPlan): ReactNode => {
    const motionClass = plan.hero.motion === "fade" ? "st-hero-fade" : "";
    const parallax = plan.hero.motion === "parallax";
    switch (plan.hero.variant) {
      case "split":
        return <HeroSplitSection ctx={ctx} density={plan.density} motif={plan.motif} motionClass={motionClass} parallax={parallax} />;
      case "editorial":
        return <HeroEditorialSection ctx={ctx} density={plan.density} motif={plan.motif} motionClass={motionClass} parallax={parallax} />;
      case "minimal":
        return <HeroMinimalSection ctx={ctx} density={plan.density} motif={plan.motif} motionClass={motionClass} />;
      default:
        return <HeroSection ctx={ctx} centered={plan.hero.centered} minH={plan.hero.minH} motionClass={motionClass} parallax={parallax} />;
    }
  };
```

…and in the v3 body replace `<HeroSection ctx={ctx} centered={plan.hero.centered} minH={plan.hero.minH} />` with `{v3Hero(plan)}`.

Add template-level gating tests to `heroVariants.test.tsx` (needs the `CommercialShopChrome` mock — copy the two `vi.mock` blocks from `renderParity.test.tsx`, then import `CommercialTemplate` and render with a seeded spec overridden to `hero: { variant: "split", motion: "fade" }` + `motion: { intensity: "calm", reveal: "fade-up" }` asserting `st-hero-fade` present and `from-black/85` absent; and the same spec with `intensity: "off"` asserting `st-hero-fade` absent).

- [ ] **Step 11: Verify** — `npx vitest run app/components/site && npx tsc`. Expected: all PASS including byte parity (mirror spec is full-bleed/none/off → default arm, empty motionClass).

- [ ] **Step 12: Commit**

```powershell
git add apps/web/app/components
git commit -m "feat(site): hero variants split/editorial/minimal + motif decor + parallax"
```

---

### Task 5: Trust Chips + Team Strip + Location MapFirst

**Files:**
- Create: `apps/web/app/components/site/sections/TrustChipsSection.tsx`
- Create: `apps/web/app/components/site/sections/TeamStripSection.tsx`
- Create: `apps/web/app/components/site/sections/LocationMapFirstSection.tsx`
- Create: `apps/web/app/components/site/sections/smallVariants.test.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx` (three dispatch arms)

**Interfaces:**
- Consumes: `makeTestCtx`, `sectionPadY`, `StarRow`, `HoursTable` (bits), `RenderPlan`.
- Produces: `TrustChipsSection({ ctx, density })`, `TeamStripSection({ ctx, density })`, `LocationMapFirstSection({ ctx, density })`.

- [ ] **Step 1: Write the failing tests** — `smallVariants.test.tsx` (same `@remix-run/react` async mock as Task 4's test file):

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "test-shop" }),
  };
});

import { TrustChipsSection } from "./TrustChipsSection";
import { TeamStripSection } from "./TeamStripSection";
import { LocationMapFirstSection } from "./LocationMapFirstSection";

const ctx = makeTestCtx();

describe("trust chips", () => {
  it("keeps the stats-bar id and renders each signal as a chip", () => {
    const html = renderToStaticMarkup(<TrustChipsSection ctx={ctx} density="airy" />);
    expect(html).toContain('id="stats-bar"');
    expect(html).toContain("Walk-ins welcome");
    expect(html).toContain("5-star rated");
    expect(html).toContain("4.8 from 12 reviews");
  });
  it("falls back to booking-benefit chips without signals or proof", () => {
    const html = renderToStaticMarkup(
      <TrustChipsSection ctx={makeTestCtx({ trustSignals: [], hasSocialProof: false })} density="airy" />,
    );
    expect(html).toContain("Online booking");
    expect(html).toContain("Instant confirmation");
  });
});

describe("team strip", () => {
  it("renders a snap-scroll rail with a book link per member", () => {
    const html = renderToStaticMarkup(<TeamStripSection ctx={ctx} density="airy" />);
    expect(html).toContain("snap-x");
    expect(html).toContain("Book with Alex");
    expect(html).toContain("staffId=st1");
  });
  it("renders nothing without staff", () => {
    expect(renderToStaticMarkup(<TeamStripSection ctx={makeTestCtx({ staff: [] })} density="airy" />)).toBe("");
  });
});

describe("location map-first", () => {
  it("leads with the map and shows hours beneath", () => {
    const withMap = makeTestCtx({ settings: { address: "1 High St", phone: "020 1234 5678", lat: 51.5, lng: -0.1 } });
    const html = renderToStaticMarkup(<LocationMapFirstSection ctx={withMap} density="airy" />);
    expect(html).toContain("Find us");
    expect(html.indexOf("iframe")).toBeLessThan(html.indexOf("Monday"));
  });
  it("renders nothing without an address", () => {
    expect(
      renderToStaticMarkup(<LocationMapFirstSection ctx={makeTestCtx({ hasAddress: false })} density="airy" />),
    ).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run app/components/site/sections/smallVariants.test.tsx`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `TrustChipsSection.tsx`**

```tsx
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow } from "~/components/site/sections/bits";

/** Trust "chips": the signal band as tactile pill chips instead of one dot-
 *  separated line. Keeps the #stats-bar id — the hero scroll cue targets it. */
export function TrustChipsSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  const signals =
    ctx.trustSignals.length > 0
      ? ctx.trustSignals
      : ["Online booking", "Instant confirmation", "Same-day slots when available"];
  return (
    <section
      id="stats-bar"
      className={`scroll-mt-24 border-y border-[color:var(--st-line-10)] bg-[color:var(--st-card-faint)] ${density === "compact" ? "py-6" : "py-8"}`}
    >
      <ul className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-3 px-4 md:px-6">
        {ctx.hasSocialProof ? (
          <li className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-10)] px-5 text-sm font-semibold text-[color:var(--st-ink-90)]">
            <StarRow rating={typeof ctx.site.rating === "number" ? ctx.site.rating : 5} className="text-sm" />
            <span>
              {ctx.statsRating} from {ctx.reviewCount} review{ctx.reviewCount === 1 ? "" : "s"}
            </span>
          </li>
        ) : null}
        {signals.map((s) => (
          <li
            key={s}
            className="inline-flex min-h-11 items-center rounded-full border border-[color:var(--st-line-20)] bg-[color:var(--st-card)] px-5 text-sm font-medium text-[color:var(--st-ink-80)]"
          >
            {s}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Implement `TeamStripSection.tsx`**

```tsx
import { Link } from "@remix-run/react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { sectionPadY } from "~/components/site/sections/bits";

/** Team "strip": a snap-scrolling rail of compact cards — browsable with one
 *  thumb, at home on mobile. */
export function TeamStripSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  if (ctx.staff.length === 0) return null;
  return (
    <section className={`border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-1)] ${sectionPadY(density)}`}>
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Meet the team</h2>
          {ctx.staff.length > 3 ? <p className="text-sm text-[color:var(--st-ink-50)]">Scroll for more</p> : null}
        </div>
      </div>
      <ul className="mt-10 flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pb-4 md:px-6 lg:px-[max(1.5rem,calc((100vw-80rem)/2))]">
        {ctx.staff.map((m) => {
          const initials = m.display_name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
          return (
            <li key={m.id} className="w-72 shrink-0 snap-start rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[color:var(--st-accent-25)] text-lg font-bold text-[color:var(--st-accent-text)]">
                  {m.avatar_url ? (
                    <img src={m.avatar_url} alt={`Photo of ${m.display_name}`} className="h-full w-full object-cover" />
                  ) : (
                    initials
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="pp-heading truncate text-lg font-semibold text-[color:var(--st-ink)]">{m.display_name}</h3>
                  {m.speciality ? <p className="truncate text-sm text-[color:var(--st-accent-text)]">{m.speciality}</p> : null}
                </div>
              </div>
              {m.bio ? <p className="mt-4 text-sm text-[color:var(--st-ink-55)] line-clamp-3">{m.bio}</p> : null}
              <Link
                to={`/${ctx.shopSlug}/book?staffId=${encodeURIComponent(m.id)}`}
                className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-[var(--st-r-sm)] border border-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--st-accent-text)] transition hover:bg-[color:var(--st-accent-10)]"
              >
                Book with {m.display_name.split(" ")[0]}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Implement `LocationMapFirstSection.tsx`**

```tsx
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { HoursTable, sectionPadY } from "~/components/site/sections/bits";

/** Location "map-first": the map leads full-width; details sit beneath it. */
export function LocationMapFirstSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  if (!ctx.hasAddress) return null;
  return (
    <section className={`border-t border-[color:var(--st-line-10)] px-4 md:px-6 ${sectionPadY(density)}`}>
      <div className="mx-auto max-w-7xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Find us</h2>
        <div className="mt-8 h-[320px] overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] md:h-[400px]">
          {ctx.settings.lat != null && ctx.settings.lng != null ? (
            <iframe
              title="Map"
              className="h-full w-full border-0"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://www.google.com/maps?q=${ctx.settings.lat}%2C${ctx.settings.lng}&z=15&output=embed`}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-[color:var(--st-ink-60)]">{ctx.settings.address}</div>
          )}
        </div>
        <div className="mt-10 grid gap-10 md:grid-cols-2">
          <div>
            {ctx.settings.phone ? (
              <p className="text-lg">
                <a href={`tel:${ctx.settings.phone.replace(/\s/g, "")}`} className="text-[color:var(--st-accent-text)]">{ctx.settings.phone}</a>
              </p>
            ) : null}
            <p className="mt-2 text-[color:var(--st-ink-70)]">{ctx.settings.address}</p>
          </div>
          <HoursTable hoursJson={ctx.settings.hours_json} />
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Dispatch arms** — in `CommercialTemplate.tsx` `v3SectionNode`, replace the three arms:

```tsx
      case "trust":
        return variant === "chips" ? <TrustChipsSection ctx={ctx} density={plan.density} /> : <TrustSection ctx={ctx} />;
      case "team":
        return variant === "strip" ? <TeamStripSection ctx={ctx} density={plan.density} /> : <TeamSection ctx={ctx} />;
      case "location":
        return variant === "map-first" ? <LocationMapFirstSection ctx={ctx} density={plan.density} /> : <LocationSection ctx={ctx} />;
```

- [ ] **Step 7: Verify** — `npx vitest run app/components/site && npx tsc`. Expected: all PASS (parity green: mirror uses icons/cards/standard).

- [ ] **Step 8: Commit**

```powershell
git add apps/web/app/components
git commit -m "feat(site): trust chips, team strip, map-first location variants"
```

---

### Task 6: Services Rows + Showcase

**Files:**
- Create: `apps/web/app/components/site/sections/ServicesRowsSection.tsx`
- Create: `apps/web/app/components/site/sections/ServicesShowcaseSection.tsx`
- Create: `apps/web/app/components/site/sections/servicesVariants.test.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx` (services arm)

**Interfaces:**
- Consumes: `makeTestCtx`, `sectionPadY`, `formatPrice`, `isGenericCategory`.
- Produces: `ServicesRowsSection({ ctx, density, glow })`, `ServicesShowcaseSection({ ctx, density, glow })`. Both keep `id="services"` (hero CTA scroll target) and the category filter chips.

- [ ] **Step 1: Write the failing tests** — `servicesVariants.test.tsx` (same `@remix-run/react` mock):

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "test-shop" }),
  };
});

import { ServicesRowsSection } from "./ServicesRowsSection";
import { ServicesShowcaseSection } from "./ServicesShowcaseSection";

const ctx = makeTestCtx();

describe("services rows", () => {
  it("renders the price list with leaders, prices and per-row booking", () => {
    const html = renderToStaticMarkup(<ServicesRowsSection ctx={ctx} density="airy" glow />);
    expect(html).toContain('id="services"');
    expect(html).toContain("border-dotted");
    expect(html).toContain("£25");
    expect(html).toContain("serviceId=s1");
  });
  it("shows skeleton rows when there are no services", () => {
    const html = renderToStaticMarkup(
      <ServicesRowsSection ctx={makeTestCtx({ services: [], filteredServices: [], categories: ["All"] })} density="airy" glow={false} />,
    );
    expect(html).toContain("animate-pulse");
  });
});

describe("services showcase", () => {
  it("alternates image direction and keeps the services id", () => {
    const html = renderToStaticMarkup(<ServicesShowcaseSection ctx={ctx} density="airy" glow />);
    expect(html).toContain('id="services"');
    expect(html).toContain("md:order-2");
    expect(html).toContain("Hot towel shave");
    expect(html).toContain("£35");
  });
  it("falls back to an accent band without an image", () => {
    const noImages = makeTestCtx();
    noImages.filteredServices = noImages.filteredServices.map((s) => ({ ...s, image_url: undefined }));
    const html = renderToStaticMarkup(<ServicesShowcaseSection ctx={noImages} density="airy" glow={false} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("bg-gradient-to-br");
  });
});
```

- [ ] **Step 2: Run to verify failure** — expected FAIL (modules missing).

- [ ] **Step 3: Implement `ServicesRowsSection.tsx`**

```tsx
import { Link } from "@remix-run/react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { formatPrice, isGenericCategory, sectionPadY } from "~/components/site/sections/bits";

/** Services "rows": the barbershop wall price list — name, dotted leader,
 *  price — with booking one tap away. */
export function ServicesRowsSection({
  ctx,
  density,
  glow,
}: {
  ctx: SiteRenderContext;
  density: Density;
  glow: boolean;
}) {
  return (
    <section id="services" className={`relative scroll-mt-24 overflow-hidden px-4 md:px-6 ${sectionPadY(density)}`}>
      {glow && (
        <div className="pointer-events-none absolute -right-32 top-8 h-72 w-72 rounded-full bg-[color:var(--st-accent-07)] blur-3xl" aria-hidden />
      )}
      <div className="relative mx-auto max-w-4xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Services</h2>
        <p className="mt-2 max-w-2xl text-[color:var(--st-ink-60)]">Choose a treatment and book in a few clicks.</p>

        {ctx.categories.length > 1 && (
          <div className="mt-8 flex flex-wrap gap-2">
            {ctx.categories.map((c) => (
              <button key={c} type="button" onClick={() => ctx.setCategory(c)}
                className={`min-h-12 rounded-full px-5 text-sm font-medium transition ${
                  ctx.category === c
                    ? "bg-[color:var(--color-accent)] text-[color:var(--st-on-accent)]"
                    : "border border-[color:var(--st-line-20)] text-[color:var(--st-ink-80)] hover:border-[color:var(--color-accent)]"
                }`}>
                {c}
              </button>
            ))}
          </div>
        )}

        <ul className="mt-10 divide-y divide-[color:var(--st-line-10)] border-y border-[color:var(--st-line-10)]">
          {ctx.filteredServices.length === 0
            ? [0, 1, 2].map((i) => (
                <li key={`placeholder-${i}`} className="py-6">
                  <div className="h-6 w-2/3 animate-pulse rounded bg-[color:var(--st-chip)]" />
                  <div className="mt-3 h-4 w-1/3 animate-pulse rounded bg-[color:var(--st-chip)]" />
                </li>
              ))
            : ctx.filteredServices.map((svc) => (
                <li key={svc.id} className={density === "compact" ? "py-4" : "py-6"}>
                  <div className="flex items-baseline gap-3">
                    <h3 className="pp-heading text-lg font-semibold leading-snug text-[color:var(--st-ink)] md:text-xl">{svc.name}</h3>
                    <span className="hidden min-w-8 flex-1 self-center border-b border-dotted border-[color:var(--st-line-20)] sm:block" aria-hidden />
                    <span className="pp-heading shrink-0 text-xl font-bold text-[color:var(--st-accent-text)] md:text-2xl">£{formatPrice(svc.price_gbp)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 text-sm text-[color:var(--st-ink-55)]">
                      <span className="tabular-nums">{svc.duration_minutes} min</span>
                      {!isGenericCategory(svc.category) ? <span> · {svc.category}</span> : null}
                      {svc.description ? <span className="hidden md:inline"> · {svc.description}</span> : null}
                    </p>
                    <Link to={`/${ctx.shopSlug}/book?serviceId=${encodeURIComponent(svc.id)}`}
                      className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-[var(--st-r-sm)] border border-[color:var(--color-accent)] px-5 pp-heading text-sm font-semibold text-[color:var(--st-accent-text)] transition hover:bg-[color:var(--st-accent-10)]">
                      Book <span aria-hidden>→</span>
                    </Link>
                  </div>
                </li>
              ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Implement `ServicesShowcaseSection.tsx`**

```tsx
import { Link } from "@remix-run/react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { formatPrice, isGenericCategory, sectionPadY } from "~/components/site/sections/bits";

/** Services "showcase": editorial full-width cards, image and copy side by
 *  side, alternating direction — for shops whose imagery carries the sell. */
export function ServicesShowcaseSection({
  ctx,
  density,
  glow,
}: {
  ctx: SiteRenderContext;
  density: Density;
  glow: boolean;
}) {
  return (
    <section id="services" className={`relative scroll-mt-24 overflow-hidden px-4 md:px-6 ${sectionPadY(density)}`}>
      {glow && (
        <div className="pointer-events-none absolute -right-32 top-8 h-72 w-72 rounded-full bg-[color:var(--st-accent-07)] blur-3xl" aria-hidden />
      )}
      <div className="relative mx-auto max-w-6xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Services</h2>
        <p className="mt-2 max-w-2xl text-[color:var(--st-ink-60)]">Choose a treatment and book in a few clicks.</p>

        {ctx.categories.length > 1 && (
          <div className="mt-8 flex flex-wrap gap-2">
            {ctx.categories.map((c) => (
              <button key={c} type="button" onClick={() => ctx.setCategory(c)}
                className={`min-h-12 rounded-full px-5 text-sm font-medium transition ${
                  ctx.category === c
                    ? "bg-[color:var(--color-accent)] text-[color:var(--st-on-accent)]"
                    : "border border-[color:var(--st-line-20)] text-[color:var(--st-ink-80)] hover:border-[color:var(--color-accent)]"
                }`}>
                {c}
              </button>
            ))}
          </div>
        )}

        <div className={`mt-10 flex flex-col ${density === "compact" ? "gap-8" : "gap-12"}`}>
          {ctx.filteredServices.length === 0
            ? [0, 1].map((i) => (
                <article key={`placeholder-${i}`} className="grid gap-6 overflow-hidden rounded-[var(--st-r-lg)] border border-dashed border-[color:var(--st-line-20)] bg-[color:var(--st-card-faint)] md:grid-cols-2 md:gap-0">
                  <div className="aspect-[16/10] animate-pulse bg-[color:var(--st-accent-15)] md:aspect-auto md:min-h-[18rem]" />
                  <div className="flex flex-col p-6 md:p-10">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--st-accent-text)]">Coming soon</p>
                    <div className="mt-3 h-7 w-2/3 animate-pulse rounded bg-[color:var(--st-chip)]" />
                    <div className="mt-4 h-4 w-1/2 animate-pulse rounded bg-[color:var(--st-chip)]" />
                  </div>
                </article>
              ))
            : ctx.filteredServices.map((svc, i) => {
                const hasImage = typeof svc.image_url === "string" && svc.image_url.trim().length > 0;
                return (
                  <article key={svc.id} className="grid items-stretch gap-0 overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card)] md:grid-cols-2">
                    <div className={`relative aspect-[16/10] md:aspect-auto md:min-h-[18rem]${i % 2 === 1 ? " md:order-2" : ""}`}>
                      {hasImage ? (
                        <img src={svc.image_url} alt={svc.name} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
                      )}
                    </div>
                    <div className="flex flex-col p-6 md:p-10">
                      {!isGenericCategory(svc.category) && (
                        <p className="mb-2 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[color:var(--st-accent-text)]">{svc.category}</p>
                      )}
                      <h3 className="pp-heading text-2xl font-semibold text-[color:var(--st-ink)] md:text-3xl">{svc.name}</h3>
                      {svc.description ? (
                        <p className="mt-3 text-sm leading-relaxed text-[color:var(--st-ink-55)] md:text-base">{svc.description}</p>
                      ) : null}
                      <p className="mt-4 text-sm text-[color:var(--st-ink-55)]">
                        <span className="pp-heading text-2xl font-bold text-[color:var(--st-accent-text)]">£{formatPrice(svc.price_gbp)}</span>
                        <span className="tabular-nums"> · {svc.duration_minutes} min</span>
                      </p>
                      <Link to={`/${ctx.shopSlug}/book?serviceId=${encodeURIComponent(svc.id)}`}
                        className="mt-6 inline-flex min-h-12 w-fit items-center justify-center gap-1.5 rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-6 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition hover:brightness-110">
                        Book this <span aria-hidden>→</span>
                      </Link>
                    </div>
                  </article>
                );
              })}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Dispatch arm** — in `v3SectionNode`:

```tsx
      case "services":
        return variant === "rows" ? (
          <ServicesRowsSection ctx={ctx} density={plan.density} glow={plan.glow} />
        ) : variant === "showcase" ? (
          <ServicesShowcaseSection ctx={ctx} density={plan.density} glow={plan.glow} />
        ) : (
          <ServicesSection ctx={ctx} cols={3} glow={plan.glow} />
        );
```

- [ ] **Step 6: Verify** — `npx vitest run app/components/site && npx tsc`. Expected: all PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/app/components
git commit -m "feat(site): services rows price-list and showcase variants"
```

---

### Task 7: About SplitImage + Story

**Files:**
- Create: `apps/web/app/components/site/sections/AboutSplitImageSection.tsx`
- Create: `apps/web/app/components/site/sections/AboutStorySection.tsx`
- Create: `apps/web/app/components/site/sections/aboutVariants.test.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx` (about arm)

**Interfaces:**
- Consumes: `makeTestCtx`, `sectionPadY`.
- Produces: `AboutSplitImageSection({ ctx, density })`, `AboutStorySection({ ctx, density })`. Both keep `id="about"`.

- [ ] **Step 1: Write the failing tests** — `aboutVariants.test.tsx` (no Link used — no mock needed):

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";
import { AboutSplitImageSection } from "./AboutSplitImageSection";
import { AboutStorySection } from "./AboutStorySection";

const ctx = makeTestCtx();

describe("about split-image", () => {
  it("pairs the story with the shop's own imagery and chip pillars", () => {
    const html = renderToStaticMarkup(<AboutSplitImageSection ctx={ctx} density="airy" />);
    expect(html).toContain('id="about"');
    expect(html).toContain("one.jpg"); // first service image
    expect(html).toContain("Expert Staff"); // pillar chip
    expect(html).toContain("proper chairs");
  });
  it("falls back to an accent panel with no imagery anywhere", () => {
    const bare = makeTestCtx({ heroSrc: "" });
    bare.services = bare.services.map((s) => ({ ...s, image_url: undefined }));
    const html = renderToStaticMarkup(<AboutSplitImageSection ctx={bare} density="airy" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("bg-gradient-to-br");
  });
});

describe("about story", () => {
  it("centres the narrative under an oversized quote glyph", () => {
    const html = renderToStaticMarkup(<AboutStorySection ctx={ctx} density="airy" />);
    expect(html).toContain('id="about"');
    expect(html).toContain("“"); // decorative ldquo
    expect(html).toContain("proper chairs");
    expect(html).toContain("Expert Staff");
  });
});
```

- [ ] **Step 2: Run to verify failure** — expected FAIL (modules missing).

- [ ] **Step 3: Implement `AboutSplitImageSection.tsx`**

```tsx
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { sectionPadY } from "~/components/site/sections/bits";

/** About "split-image": the story beside a tall photo pulled from the shop's
 *  own imagery; pillars compress into a chip row under the text. */
export function AboutSplitImageSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  const img =
    ctx.services.find((s) => typeof s.image_url === "string" && s.image_url.trim())?.image_url ?? ctx.heroSrc;
  return (
    <section id="about" className={`border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 md:px-6 ${sectionPadY(density)}`}>
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="pp-heading text-[clamp(1.5rem,3.5vw,2rem)] font-bold text-[color:var(--st-ink)]">{ctx.aboutHeading}</h2>
          {ctx.aboutText ? (
            <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-[color:var(--st-ink-75)] md:text-lg">{ctx.aboutText}</p>
          ) : null}
          <ul className="mt-8 flex flex-wrap gap-3">
            {ctx.pillars.map((pillar) => (
              <li key={pillar.title} className="inline-flex min-h-11 items-center rounded-full border border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-10)] px-5 pp-heading text-sm font-semibold text-[color:var(--st-ink-90)]">
                {pillar.title}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative aspect-[4/5] max-h-[560px] w-full overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)]">
          {img ? (
            <img src={img} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
          )}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Implement `AboutStorySection.tsx`**

```tsx
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { sectionPadY } from "~/components/site/sections/bits";

/** About "story": a single centred narrative column under an oversized
 *  quotation glyph — the owner's voice, given the floor. */
export function AboutStorySection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  return (
    <section id="about" className={`relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 md:px-6 ${sectionPadY(density)}`}>
      <span className="pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 pp-heading text-[10rem] leading-none text-[color:var(--st-accent-10)]" aria-hidden>
        &ldquo;
      </span>
      <div className="relative mx-auto max-w-3xl pt-16 text-center">
        <h2 className="pp-heading text-[clamp(1.5rem,3.5vw,2rem)] font-bold text-[color:var(--st-ink)]">{ctx.aboutHeading}</h2>
        {ctx.aboutText ? (
          <p className="mx-auto mt-6 max-w-2xl whitespace-pre-line text-left text-lg leading-loose text-[color:var(--st-ink-75)] md:text-xl">{ctx.aboutText}</p>
        ) : null}
        <ul className="mt-10 flex flex-wrap items-start justify-center gap-x-10 gap-y-6">
          {ctx.pillars.map((pillar) => (
            <li key={pillar.title} className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--st-accent-20)] text-[color:var(--st-accent-text)]">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">{pillar.icon}</svg>
              </span>
              <span className="pp-heading text-base font-semibold text-[color:var(--st-ink)]">{pillar.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Dispatch arm**

```tsx
      case "about":
        return variant === "split-image" ? (
          <AboutSplitImageSection ctx={ctx} density={plan.density} />
        ) : variant === "story" ? (
          <AboutStorySection ctx={ctx} density={plan.density} />
        ) : (
          <AboutSection ctx={ctx} pillarStyle="icons" />
        );
```

- [ ] **Step 6: Verify** — `npx vitest run app/components/site && npx tsc`. Expected: all PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/app/components
git commit -m "feat(site): about split-image and story variants"
```

---

### Task 8: Reviews Marquee + Spotlight

**Files:**
- Create: `apps/web/app/components/site/sections/ReviewsMarqueeSection.tsx`
- Create: `apps/web/app/components/site/sections/ReviewsSpotlightSection.tsx`
- Create: `apps/web/app/components/site/sections/reviewsVariants.test.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx` (reviews arm)

**Interfaces:**
- Consumes: `makeTestCtx`, `sectionPadY`, `StarRow`, `formatReviewDate`, motion.css marquee classes.
- Produces: `ReviewsMarqueeSection({ ctx, density, animate, heading? })` — `heading` defaults to `"Reviews"`; Task 9 reuses it as the marquee-reviews signature with `heading="What clients say"`. `ReviewsSpotlightSection({ ctx, density })`. Both return null with no reviews.

- [ ] **Step 1: Write the failing tests** — `reviewsVariants.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";
import { ReviewsMarqueeSection } from "./ReviewsMarqueeSection";
import { ReviewsSpotlightSection } from "./ReviewsSpotlightSection";

const ctx = makeTestCtx();

describe("reviews marquee", () => {
  it("renders a doubled track when animating", () => {
    const html = renderToStaticMarkup(<ReviewsMarqueeSection ctx={ctx} density="airy" animate />);
    expect(html).toContain("st-marquee-track");
    const first = html.indexOf("Great cut, will be back.");
    const second = html.indexOf("Great cut, will be back.", first + 1);
    expect(second).toBeGreaterThan(first); // duplicated for the seamless loop
    expect(html).toContain("aria-hidden");
  });
  it("renders a hand-scrollable rail when motion is off", () => {
    const html = renderToStaticMarkup(<ReviewsMarqueeSection ctx={ctx} density="airy" animate={false} />);
    expect(html).not.toContain("st-marquee-track");
    expect(html).toContain("overflow-x-auto");
  });
  it("renders nothing without reviews and honours a custom heading", () => {
    expect(renderToStaticMarkup(<ReviewsMarqueeSection ctx={makeTestCtx({ sortedReviews: [] })} density="airy" animate />)).toBe("");
    expect(
      renderToStaticMarkup(<ReviewsMarqueeSection ctx={ctx} density="airy" animate heading="What clients say" />),
    ).toContain("What clients say");
  });
});

describe("reviews spotlight", () => {
  it("features the strongest quote large with the rest in a grid", () => {
    const html = renderToStaticMarkup(<ReviewsSpotlightSection ctx={ctx} density="airy" />);
    // r1 (rating 5) leads; r2 lands in the small grid after it.
    expect(html.indexOf("Great cut, will be back.")).toBeLessThan(html.indexOf("Friendly and quick."));
    expect(html).toContain("<figure");
  });
  it("renders nothing without reviews", () => {
    expect(renderToStaticMarkup(<ReviewsSpotlightSection ctx={makeTestCtx({ sortedReviews: [] })} density="airy" />)).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure** — expected FAIL (modules missing).

- [ ] **Step 3: Implement `ReviewsMarqueeSection.tsx`**

```tsx
import type { CSSProperties } from "react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow, formatReviewDate, sectionPadY } from "~/components/site/sections/bits";

function MarqueeCard({ r }: { r: SiteRenderContext["sortedReviews"][number] }) {
  return (
    <blockquote className="w-80 shrink-0 rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-6">
      <StarRow rating={r.rating} className="text-base" />
      <p className="mt-3 text-[color:var(--st-ink-90)] line-clamp-4">&ldquo;{r.body}&rdquo;</p>
      <footer className="mt-4 flex items-center justify-between text-sm text-[color:var(--st-ink-50)]">
        <cite className="not-italic font-medium text-[color:var(--st-ink-70)]">{r.customer_name}</cite>
        <span>{formatReviewDate(r.created_at)}</span>
      </footer>
    </blockquote>
  );
}

/** Reviews "marquee": a slow self-scrolling rail of quotes; hover/focus
 *  pauses it, reduced-motion stops it (CSS), and motion-off renders a
 *  hand-scrollable rail instead. Doubles as the marquee-reviews signature. */
export function ReviewsMarqueeSection({
  ctx,
  density,
  animate,
  heading = "Reviews",
}: {
  ctx: SiteRenderContext;
  density: Density;
  animate: boolean;
  heading?: string;
}) {
  if (ctx.sortedReviews.length === 0) return null;
  const cards = ctx.sortedReviews.map((r) => <MarqueeCard key={r.id} r={r} />);
  return (
    <section className={`overflow-hidden ${sectionPadY(density)}`}>
      <h2 className="mx-auto max-w-7xl px-4 pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)] md:px-6">
        {heading}
      </h2>
      {animate ? (
        <div className="st-marquee mt-10">
          <div
            className="st-marquee-track flex w-max"
            style={{ "--st-marquee-dur": `${Math.max(30, ctx.sortedReviews.length * 8)}s` } as CSSProperties}
          >
            <div className="flex gap-6 pr-6">{cards}</div>
            <div className="flex gap-6 pr-6" aria-hidden>{cards}</div>
          </div>
        </div>
      ) : (
        <div className="mt-10 flex snap-x gap-6 overflow-x-auto px-4 pb-4 md:px-6">{cards}</div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Implement `ReviewsSpotlightSection.tsx`**

```tsx
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow, formatReviewDate, sectionPadY } from "~/components/site/sections/bits";

/** Reviews "spotlight": one voice leads — the strongest quote set large —
 *  with the rest in a quiet grid beneath. */
export function ReviewsSpotlightSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  if (ctx.sortedReviews.length === 0) return null;
  const [featured, ...rest] = [...ctx.sortedReviews].sort(
    (a, b) => b.rating - a.rating || b.body.length - a.body.length,
  );
  return (
    <section className={`relative overflow-hidden px-4 md:px-6 ${sectionPadY(density)}`}>
      <div className="mx-auto max-w-7xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Reviews</h2>
        <figure className="relative mx-auto mt-12 max-w-3xl text-center">
          <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 pp-heading text-[8rem] leading-none text-[color:var(--st-accent-10)]" aria-hidden>
            &ldquo;
          </span>
          <StarRow rating={featured!.rating} className="relative text-lg" />
          <blockquote className="relative mt-4 text-[clamp(1.25rem,2.6vw,1.75rem)] font-light leading-relaxed text-[color:var(--st-ink-90)]">
            &ldquo;{featured!.body}&rdquo;
          </blockquote>
          <figcaption className="mt-5 text-sm text-[color:var(--st-ink-60)]">
            <cite className="not-italic font-semibold text-[color:var(--st-ink-80)]">{featured!.customer_name}</cite>
            {" · "}
            {formatReviewDate(featured!.created_at)}
          </figcaption>
        </figure>
        {rest.length > 0 ? (
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {rest.slice(0, 4).map((r) => (
              <blockquote key={r.id} className="rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-5">
                <StarRow rating={r.rating} className="text-sm" />
                <p className="mt-2 text-sm text-[color:var(--st-ink-80)] line-clamp-4">&ldquo;{r.body}&rdquo;</p>
                <footer className="mt-3 text-xs text-[color:var(--st-ink-50)]">
                  <cite className="not-italic">{r.customer_name}</cite>
                </footer>
              </blockquote>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Dispatch arm**

```tsx
      case "reviews":
        return variant === "marquee" ? (
          <ReviewsMarqueeSection ctx={ctx} density={plan.density} animate={plan.reveal !== null} />
        ) : variant === "spotlight" ? (
          <ReviewsSpotlightSection ctx={ctx} density={plan.density} />
        ) : (
          <ReviewsSection ctx={ctx} />
        );
```

- [ ] **Step 6: Verify** — `npx vitest run app/components/site && npx tsc`. Expected: all PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/web/app/components
git commit -m "feat(site): reviews marquee and spotlight variants"
```

---

### Task 9: Signature sections (Gallery + Spotlight) + useCountUp + placement

**Files:**
- Create: `apps/web/app/components/site/motion/useCountUp.ts`
- Create: `apps/web/app/components/site/sections/SignatureGallerySection.tsx`
- Create: `apps/web/app/components/site/sections/SignatureSpotlightSection.tsx`
- Create: `apps/web/app/components/site/sections/signatures.test.tsx`
- Modify: `apps/web/app/components/CommercialTemplate.tsx` (signature node before FinalCta)

**Interfaces:**
- Consumes: `makeTestCtx`, `sectionPadY`, `MotifDecor`, `formatPrice`, `useParallax`, `ReviewsMarqueeSection` (Task 8), `RenderPlan`.
- Produces: `useCountUp(target: number, enabled: boolean): { ref: RefObject<HTMLSpanElement | null>; value: number }` (SSR/no-JS renders the final value); `SignatureGallerySection({ ctx, images, density, motif })` (null under 3 images); `SignatureSpotlightSection({ ctx, density, motif, animate })` (null without services). Template renders the signature wrapped in `Reveal` immediately before `FinalCtaSection`.

- [ ] **Step 1: Write the failing tests** — `signatures.test.tsx` (same `@remix-run/react` async mock as Task 4; import after the mock):

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "test-shop" }),
  };
});

import { SignatureGallerySection } from "./SignatureGallerySection";
import { SignatureSpotlightSection } from "./SignatureSpotlightSection";

const ctx = makeTestCtx();
const images = ["https://img.example/hero.jpg", "https://img.example/one.jpg", "https://img.example/two.jpg", "https://img.example/three.jpg"];

describe("signature gallery", () => {
  it("renders a look-book grid with tall accents from the shop's imagery", () => {
    const html = renderToStaticMarkup(<SignatureGallerySection ctx={ctx} images={images} density="airy" motif="line" />);
    expect(html).toContain("Inside Test Shop");
    expect(html).toContain("row-span-2");
    expect(html).toContain("one.jpg");
  });
  it("renders nothing with fewer than 3 images", () => {
    expect(
      renderToStaticMarkup(<SignatureGallerySection ctx={ctx} images={images.slice(0, 2)} density="airy" motif="none" />),
    ).toBe("");
  });
});

describe("signature spotlight", () => {
  it("stages the priciest photographed service with real stats and a booking CTA", () => {
    const html = renderToStaticMarkup(<SignatureSpotlightSection ctx={ctx} density="airy" motif="arc" animate={false} />);
    expect(html).toContain("Signature service");
    expect(html).toContain("Hot towel shave"); // priciest with an image
    expect(html).toContain("£35");
    expect(html).toContain("serviceId=s3");
    expect(html).toContain(">12<"); // SSR renders the final review count
  });
  it("hides social-proof stats without reviews and renders nothing without services", () => {
    const noProof = makeTestCtx({ hasSocialProof: false, reviewCount: 0 });
    const html = renderToStaticMarkup(<SignatureSpotlightSection ctx={noProof} density="airy" motif="none" animate={false} />);
    expect(html).not.toContain("Average rating");
    expect(
      renderToStaticMarkup(
        <SignatureSpotlightSection ctx={makeTestCtx({ services: [] })} density="airy" motif="none" animate={false} />,
      ),
    ).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify failure** — expected FAIL (modules missing).

- [ ] **Step 3: Implement `useCountUp.ts`**

```ts
import { useEffect, useRef, useState } from "react";

/** Counts a stat up from zero the first time it scrolls into view. SSR and
 *  no-JS render the final value (state starts at `target`); the zeroing +
 *  animation happen only client-side, and only when `enabled` and motion is
 *  not reduced. */
export function useCountUp(target: number, enabled: boolean) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState(target);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === "undefined") {
      setValue(target);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    let raf = 0;
    setValue(0);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const started = performance.now();
        const dur = 900;
        const tick = (now: number) => {
          const t = Math.min(1, (now - started) / dur);
          setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [target, enabled]);
  return { ref, value };
}
```

- [ ] **Step 4: Implement `SignatureGallerySection.tsx`**

```tsx
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor, sectionPadY } from "~/components/site/sections/bits";

/** Signature "gallery": the shop's own imagery as a look-book wall — every
 *  third tile runs tall so the grid reads composed, not templated. Images
 *  are ambiance (decorative): empty alt, lazy. */
export function SignatureGallerySection({
  ctx,
  images,
  density,
  motif,
}: {
  ctx: SiteRenderContext;
  images: string[];
  density: Density;
  motif: Motif;
}) {
  if (images.length < 3) return null;
  const tiles = images.slice(0, 8);
  return (
    <section className={`relative overflow-hidden border-t border-[color:var(--st-line-10)] px-4 md:px-6 ${sectionPadY(density)}`}>
      {motif !== "line" ? <MotifDecor motif={motif} className="-right-16 top-10" /> : null}
      <div className="relative mx-auto max-w-7xl">
        {motif === "line" ? <MotifDecor motif="line" className="mb-6 w-fit" /> : null}
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-accent-text)]">The space</p>
        <h2 className="mt-3 pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">
          Inside {ctx.site.shop_name}
        </h2>
        <ul className="mt-10 grid auto-rows-[9rem] grid-cols-2 gap-3 md:auto-rows-[11rem] md:grid-cols-4 md:gap-4">
          {tiles.map((src, i) => (
            <li key={src} className={`overflow-hidden rounded-[var(--st-r-md)]${i % 3 === 0 ? " row-span-2" : ""}`}>
              <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover transition duration-500 hover:scale-105" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Implement `SignatureSpotlightSection.tsx`** (hooks run before the null return — React rules):

```tsx
import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor, formatPrice, sectionPadY } from "~/components/site/sections/bits";
import { useCountUp } from "~/components/site/motion/useCountUp";
import { useParallax } from "~/components/site/motion/useParallax";

/** Signature "spotlight": the shop's headline treatment given a full stage —
 *  slow-drifting imagery, count-up stats (real numbers only), one focused
 *  call to book it. */
export function SignatureSpotlightSection({
  ctx,
  density,
  motif,
  animate,
}: {
  ctx: SiteRenderContext;
  density: Density;
  motif: Motif;
  animate: boolean;
}) {
  const featured =
    [...ctx.services]
      .sort((a, b) => b.price_gbp - a.price_gbp)
      .find((s) => typeof s.image_url === "string" && s.image_url.trim()) ?? ctx.services[0];
  const reviewsStat = useCountUp(ctx.reviewCount, animate);
  const servicesStat = useCountUp(ctx.services.length, animate);
  const imgRef = useParallax<HTMLImageElement>(animate, 12, "scale(1.05)");
  if (!featured) return null;
  const hasImage = typeof featured.image_url === "string" && featured.image_url.trim().length > 0;
  return (
    <section className={`relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-1)] px-4 md:px-6 ${sectionPadY(density)}`}>
      {motif !== "line" ? <MotifDecor motif={motif} className="-left-16 bottom-10" /> : null}
      <div className="relative mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className="relative aspect-[4/5] max-h-[560px] w-full overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)]">
          {hasImage ? (
            <img
              ref={imgRef}
              src={featured.image_url}
              alt={featured.name}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full scale-105 object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
          )}
        </div>
        <div>
          {motif === "line" ? <MotifDecor motif="line" className="mb-6 w-fit" /> : null}
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-accent-text)]">Signature service</p>
          <h2 className="mt-3 pp-heading text-[clamp(1.85rem,4.5vw,3rem)] font-bold leading-tight text-[color:var(--st-ink)]">{featured.name}</h2>
          {featured.description ? (
            <p className="mt-4 text-base leading-relaxed text-[color:var(--st-ink-70)] md:text-lg">{featured.description}</p>
          ) : null}
          <p className="mt-5 text-sm text-[color:var(--st-ink-55)]">
            <span className="pp-heading text-3xl font-bold text-[color:var(--st-accent-text)]">£{formatPrice(featured.price_gbp)}</span>
            <span className="tabular-nums"> · {featured.duration_minutes} min</span>
          </p>
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-[color:var(--st-line-10)] pt-6">
            {ctx.hasSocialProof ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[color:var(--st-ink-50)]">Reviews</dt>
                <dd className="mt-1 pp-heading text-3xl font-bold tabular-nums text-[color:var(--st-ink)]">
                  <span ref={reviewsStat.ref}>{reviewsStat.value}</span>
                </dd>
              </div>
            ) : null}
            {ctx.services.length >= 3 ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[color:var(--st-ink-50)]">Treatments</dt>
                <dd className="mt-1 pp-heading text-3xl font-bold tabular-nums text-[color:var(--st-ink)]">
                  <span ref={servicesStat.ref}>{servicesStat.value}</span>
                </dd>
              </div>
            ) : null}
            {ctx.hasSocialProof ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[color:var(--st-ink-50)]">Average rating</dt>
                <dd className="mt-1 pp-heading text-3xl font-bold tabular-nums text-[color:var(--st-ink)]">{ctx.statsRating}★</dd>
              </div>
            ) : null}
          </dl>
          <Link
            to={`/${ctx.shopSlug}/book?serviceId=${encodeURIComponent(featured.id)}`}
            className="mt-8 inline-flex min-h-12 items-center justify-center gap-1.5 rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] transition hover:brightness-110"
          >
            Book this <span aria-hidden>→</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Template placement** — in `CommercialTemplate.tsx` import the two signature components, then add above the return:

```tsx
  // Signature imagery pool: hero + service photos, deduped, order-stable.
  const signatureImages = Array.from(
    new Set([heroSrc, ...services.map((s) => (typeof s.image_url === "string" ? s.image_url : ""))].map((s) => s.trim()).filter(Boolean)),
  );

  const v3SignatureNode = (plan: RenderPlan): ReactNode => {
    switch (plan.signature) {
      case "gallery":
        return signatureImages.length >= 3 ? (
          <SignatureGallerySection ctx={ctx} images={signatureImages} density={plan.density} motif={plan.motif} />
        ) : null;
      case "marquee-reviews":
        return sortedReviews.length > 0 ? (
          <ReviewsMarqueeSection ctx={ctx} density={plan.density} animate={plan.reveal !== null} heading="What clients say" />
        ) : null;
      case "spotlight":
        return services.length > 0 ? (
          <SignatureSpotlightSection ctx={ctx} density={plan.density} motif={plan.motif} animate={plan.reveal !== null} />
        ) : null;
      default:
        return null;
    }
  };
```

…and in the v3 body, between the visible-sections map and the FinalCta `Reveal`, insert (the IIFE keeps the null check local so no empty reveal div is ever emitted):

```tsx
              {(() => {
                const sig = v3SignatureNode(plan);
                return sig ? (
                  <Reveal enabled={enabled} style={style} index={visible.length} lively={lively}>
                    {sig}
                  </Reveal>
                ) : null;
              })()}
              <Reveal enabled={enabled} style={style} index={visible.length + 1} lively={lively}>
                <FinalCtaSection ctx={ctx} glow={plan.glow} />
              </Reveal>
```

Add one template-level test to `signatures.test.tsx` (with the `CommercialShopChrome` mock copied from `renderParity.test.tsx` and `CommercialTemplate` imported after the mocks): render a seeded spec overridden with `signature: "spotlight"`, `motion: { intensity: "off", reveal: "fade-up" }`, services with images passed as props, and assert `"Signature service"` appears BEFORE the final CTA heading (`ctx` copy `"Ready for your best look?"` via `html.indexOf` ordering); plus `signature: null` renders no `"Signature service"`.

- [ ] **Step 7: Verify** — `npx vitest run app/components/site && npx tsc`. Expected: all PASS (parity mirror has `signature: null` → no signature node, byte parity holds).

- [ ] **Step 8: Commit**

```powershell
git add apps/web/app/components
git commit -m "feat(site): signature gallery and spotlight + count-up stats"
```

---

### Task 10: Seeded sweep + full verification + PR

**Files:**
- Create: `apps/web/app/components/site/seededSweep.test.tsx`

**Interfaces:**
- Consumes: everything above; `seedComposeDesignSpec` from `@repo/utils`.

- [ ] **Step 1: Write the sweep test** — `seededSweep.test.tsx`:

```tsx
/** Renders 24 seeded specs (plus off/lively overrides) through the full
 *  template: every seed must produce a bookable page, never a crash. */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { seedComposeDesignSpec, type MotionIntensity } from "@repo/utils";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "sweep-shop" }),
  };
});
vi.mock("~/components/CommercialShopChrome", async () => {
  const React = await import("react");
  return {
    CommercialShopChrome: ({ children }: { children: unknown }) =>
      React.createElement("div", null, children as never),
  };
});

import CommercialTemplate from "~/components/CommercialTemplate";

const services = [
  { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30, category: "Hair", image_url: "https://img.example/a.jpg" },
  { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20, image_url: "https://img.example/b.jpg" },
  { id: "s3", name: "Hot towel shave", price_gbp: 35, duration_minutes: 45, image_url: "https://img.example/c.jpg" },
];
const staff = [{ id: "st1", display_name: "Alex Doe" }];
const reviews = [
  { id: "r1", customer_name: "Sam", rating: 5, body: "Great cut.", created_at: "2026-01-05T10:00:00Z" },
  { id: "r2", customer_name: "Ash", rating: 4, body: "Quick and friendly.", created_at: "2026-01-04T10:00:00Z" },
];

describe("seeded sweep", () => {
  const intensities: MotionIntensity[] = ["off", "calm", "lively"];
  for (let i = 0; i < 24; i++) {
    const shopId = `sweep-shop-${i}`;
    for (const intensity of intensities) {
      it(`renders ${shopId} (${intensity}) bookable`, () => {
        const spec = seedComposeDesignSpec(shopId);
        const html = renderToStaticMarkup(
          <CommercialTemplate
            site={{
              shop_id: shopId,
              shop_name: `Sweep Shop ${i}`,
              tagline: "Sharp",
              hero_image_url: "https://img.example/hero.jpg",
              design_version: 3,
              design_spec: { ...spec, motion: { ...spec.motion, intensity } },
            }}
            services={services}
            staff={staff}
            reviews={reviews}
            settings={{ address: "1 High St" }}
          />,
        );
        expect(html).toContain(`Sweep Shop ${i}`);
        expect(html).toContain("/sweep-shop/book"); // a booking path always renders
        expect(html).toContain('id="services"'); // services section always present
      });
    }
  }
});
```

- [ ] **Step 2: Run the sweep** — `npx vitest run app/components/site/seededSweep.test.tsx`. Expected: 72 PASS. Any failure is a real variant bug — fix the component, not the test.

- [ ] **Step 3: Full verification** (repo root):

```powershell
cd apps/web; npx vitest run; npx tsc; npm run lint; cd ../..
npm run build
npm run check-types
```

Expected: web suite all green (including byte parity), tsc clean, lint zero warnings, turbo build succeeds (proves the motion.css import bundles).

- [ ] **Step 4: Commit + push + PR**

```powershell
git add apps/web
git commit -m "test(site): seeded sweep across 24 specs x 3 intensities"
git push -u origin feat/design-v3-variants
gh pr create --title "feat(site): v3 variant library + motion + signature sections (2b-2)" --body "<summary of variants, motion system, parity anchor move, signature placement; note: apps/web only, no migration; parity: motion-off mirror spec byte-identical to legacy>"
gh pr checks --watch
```

STOP after CI is green: the user merges (`gh pr merge --squash --delete-branch` is theirs to run — plain branch, no stack).

---

## Self-Review Notes (already applied)

- Spec coverage: hero 4 variants (full-bleed = existing), services 3 (grid = existing), about 3 (standard = existing), team 2 (cards = existing), trust 2 (icons = existing), how 2 (existing via stepsStyle), reviews 3 (cards = existing), location 2 (standard = existing), signatures 3 (marquee-reviews reuses ReviewsMarqueeSection) — every id in `SECTION_VARIANTS` + `HERO_VARIANTS` + `SIGNATURES` has a dispatch arm. Motion: reveal 3 styles, intensity 3 (off = null reveal), hero motion 3 (fade class, parallax hook, none), marquee, count-up. Motif 4 (none renders nothing). Density via `sectionPadY` in new variants only.
- Parity: mirror spec = motion off + legacy ids + null signature; `Reveal` disabled renders bare children; `HeroSection` new props default to byte-identical output; `motion.css` import is markup-neutral.
- Type consistency: `RenderPlan`/`RevealPlan`/`SectionPlan` defined once in Task 3 and consumed verbatim in Tasks 4-9; all variant components take `ctx` + `density` (+ `motif`/`glow`/`animate`/`motionClass`/`parallax` where stated).
- Known accepted limitations (document in PR body): existing sections ignore density; `AboutSection` v3 arm pins `pillarStyle="icons"`; seeded sites never pick intensity "off" (composer guarantees motion) so the off path is owner/AI-only; marquee duplicates review content for the loop (aria-hidden).





