# Mobile Native Feel (Site Design v3, PR 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated shop sites feel app-like on phones: a sticky bottom booking bar that appears once the hero scrolls away, safe-area-aware chrome, press feedback on primary buttons, contained overscroll on panels, and two new "install this shop's app" surfaces (mobile menu row, booking-confirmation chip) that reuse the existing install logic.

**Architecture:** Everything is web-only (`apps/web`) and additive. A small `useScrolledPastHero` hook watches the page hero (or a first-viewport sentinel) with an IntersectionObserver and drives a presentational `MobileBookingBar` rendered by `CommercialShopChrome`; pages whose flow owns the CTA opt out with a `bookingBar={false}` prop. Install capability moves out of `InstallAppPrompt` into a module-level store (`lib/installPrompt.ts`, consumed via `useSyncExternalStore`) so the root-mounted invitation, the menu row and the confirmation chip share one captured `beforeinstallprompt` event and one iOS walkthrough. Safe areas, the bar's slide transition, and the chat launcher lift live in one stylesheet (`shop-chrome.css`) imported by the chrome.

**Tech Stack:** Remix (Cloudflare Pages) + React 18.3, Tailwind 3.4, vitest + jsdom (`apps/web`), lucide-react icons, existing `useModalA11y` focus-trap hook, existing per-shop web manifest + `InstallAppPrompt`.

**Spec:** `docs/superpowers/specs/2026-07-19-site-design-v3-native-picker-design.md`, Section B ("App-like native feel + install"). Sections A and C shipped in July 2026 (PRs #87 through #101); this plan is the third and final PR of that program.

## Global Constraints

Every task's requirements implicitly include these:

- **Web-only.** No worker, migration, or background-worker change. Merging to `main` deploys via the CI "Deploy Remix Frontend to Cloudflare Pages" workflow only.
- **Spec non-goals still hold:** no service worker, no iOS/Android platform-mimicking UI, no new dependencies (motion is CSS + one hook; `@testing-library` is NOT installed and must not be added).
- **Shop-site UI consumes only `--st-*` theme tokens** (plus `--color-accent` / `--st-on-accent` for accent-filled controls); never raw colours. Touch targets are at least 44px (`min-h-12` = 48px is the house size).
- **No em-dashes in user-facing text** (CLAUDE.md). Use commas or full stops.
- **Hidden-until-JS rule:** the bottom bar's SSR markup is always in its hidden state, and the install surfaces render `null` on the server and on browsers that cannot install. No-JS visitors keep today's header "Book" button.
- **Parity tests must stay green.** `renderParity.test.tsx` byte-compares the legacy render path against v3 with motion off; both paths render `HeroSection.tsx`, so edits to it are parity-safe by construction. Run `renderParity`, `seededSweep`, and `imageAwareVariants` after any section change.
- **Test conventions (copy exactly):** SSR assertions use `renderToStaticMarkup` with `vi.mock("@remix-run/react")` stubbing `Link` as an `<a>` (pattern in `apps/web/app/components/site/sections/heroVariants.test.tsx`) and `vi.mock("lucide-react")` stubbing every icon the component imports as `() => null` (the monorepo hoists a second React and lucide's CJS bundle resolves it, breaking `renderToStaticMarkup`; see `VisualManager.test.tsx`). Client-render tests use `createRoot` + `act` from `react` with `(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true` at the top of the file (pattern in `apps/web/app/components/site/motion/reveal.test.tsx`).
- **Commands:** from `apps/web`: `npx vitest run <path>` (one file), `npm test` (suite), `npx tsc` (types), `npm run lint` (eslint, zero warnings), `npm run build`. From the repo root: `npm run check-types`.
- **TypeScript is strict with `noUncheckedIndexedAccess: true`:** guard every indexed read (`entries[0]` is `T | undefined`).
- **Branch:** `feat/mobile-native-feel` off `main` (head `6daa65f`), plain PR (no stacking). Add the `e2e` label before merge so the staging gate runs. Playwright runs at a desktop viewport (1280 by 720), so the `md:hidden` bar does not affect existing specs.
- **Commit trailers:** every commit message ends with these two lines (the commit commands below include them via a second `-m $'...'` argument; keep them verbatim):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB`.
- **Temp files:** never write under `/tmp`; use `mktemp -d` (or the session scratchpad) for logs.
- **Remix `.js` route twins:** none exist today (verified 2026-09-11). If a build emits one beside an edited `.tsx` route, delete it before committing.
- **Existing standalone-mode body padding** in `apps/web/app/tailwind.css` (lines 16 to 24) stays as is. It pads in-flow content. Fixed chrome ignores it; the sticky header does not (it is in flow at rest), so shop-chrome.css zeroes the body's top padding under the shop chrome and the header owns the top inset.

## Decisions made while planning (surfaced for the owner; none block execution)

1. **Waitlist page also suppresses the bar.** The spec names `/book` and `/confirm`; `/waitlist` is the same kind of page (its form owns the CTA, and a "Book now" bar would pull visitors away from joining a waitlist). Legal pages (privacy, terms, cookies) keep the bar.
2. **Bar copy is "Book now →"** (spec wording plus the chrome's arrow convention). Booking disabled: "View services →" linking to `/{slug}#services`, matching the header.
3. **Cookie notice sits above the bar.** `ShopSiteCookieConsent` is `z-[60]`; the bar is `z-50`. Until "Got it" is tapped the notice covers the bar. No extra plumbing.
4. **Chat launcher and panel lift above the bar** on small screens only, via a CSS variable the chrome toggles (`--pp-bar-lift`). Without this the 56px launcher would sit on top of the bar.
5. **The on-demand install guide ignores the "Not now" memory.** Dismissing the unprompted invitation still records `pp-install-dismissed`; a tap on the menu row or confirmation chip is an explicit ask and always works.
6. **Hero detection uses a `data-pp-hero` marker** on each hero variant's root `<section>`; pages without a hero use an absolutely positioned first-viewport sentinel. The bar hides again if the visitor scrolls back up to the hero.
7. **`ShopSiteCookieConsent` gets safe-area padding too.** Not in the spec's list, but it is a fixed bottom surface on shop sites with the identical defect; one class fixes it.

## File map

| File | Responsibility |
|------|----------------|
| Create `apps/web/app/lib/useScrolledPastHero.ts` (+ `.test.tsx`) | IntersectionObserver hook: `pastHero` boolean + sentinel ref |
| Modify `apps/web/app/components/site/sections/{HeroSection,HeroSplitSection,HeroEditorialSection,HeroMinimalSection}.tsx` | `data-pp-hero` marker; press feedback on the primary CTA |
| Modify `apps/web/app/components/site/sections/FinalCtaSection.tsx` | press feedback on the primary CTA |
| Create `apps/web/app/components/MobileBookingBar.tsx` (+ `.test.tsx`) | presentational fixed bottom bar |
| Create `apps/web/app/components/shop-chrome.css` | bar transition, sentinel, safe-area utilities, chat lift |
| Modify `apps/web/app/components/CommercialShopChrome.tsx` | sentinel, bar, `bookingBar` prop, install row, safe areas, press states, overscroll |
| Create `apps/web/app/components/CommercialShopChrome.test.tsx` | SSR + client assertions on the chrome |
| Create `apps/web/app/lib/installPrompt.ts` (+ `.test.ts`) | install capability store and hooks |
| Modify `apps/web/app/components/InstallAppPrompt.tsx` (+ new `.test.tsx`) | consume the store; on-demand guide mode |
| Create `apps/web/app/components/InstallAppButton.tsx` (+ `.test.tsx`) | menu-row and chip trigger |
| Modify `apps/web/app/routes/$shopSlug.book.tsx`, `$shopSlug.confirm.tsx`, `$shopSlug.waitlist.tsx` | `bookingBar={false}`; confirmation chip |
| Modify `apps/web/app/components/ShopSiteCookieConsent.tsx` | safe-area padding |

---

### Task 1: `useScrolledPastHero` hook + hero markers

**Files:**
- Create: `apps/web/app/lib/useScrolledPastHero.ts`
- Create: `apps/web/app/lib/useScrolledPastHero.test.tsx`
- Modify: `apps/web/app/components/site/sections/HeroSection.tsx:22`
- Modify: `apps/web/app/components/site/sections/HeroSplitSection.tsx:26`
- Modify: `apps/web/app/components/site/sections/HeroEditorialSection.tsx:26`
- Modify: `apps/web/app/components/site/sections/HeroMinimalSection.tsx:21`
- Modify: `apps/web/app/components/site/sections/heroVariants.test.tsx` (append one test)

**Interfaces:**
- Produces: `HERO_MARKER_ATTR = "data-pp-hero"` and `useScrolledPastHero(enabled: boolean): { sentinelRef: RefObject<HTMLDivElement>; pastHero: boolean }`. Task 3 consumes both.

- [ ] **Step 1: Write the failing hook test**

Create `apps/web/app/lib/useScrolledPastHero.test.tsx`:

```tsx
/** useScrolledPastHero: observes the page hero (data-pp-hero) or, without one,
 *  the sentinel; reports true only once the target has left the viewport. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { HERO_MARKER_ATTR, useScrolledPastHero } from "./useScrolledPastHero";

type Entry = { isIntersecting: boolean; target: Element };
let ioCallback: ((entries: Entry[]) => void) | null = null;
const observed: Element[] = [];
let disconnected = 0;

class MockIntersectionObserver {
  constructor(cb: (entries: Entry[]) => void) {
    ioCallback = cb;
  }
  observe(el: Element) {
    observed.push(el);
  }
  unobserve() {}
  disconnect() {
    disconnected += 1;
  }
}

function Harness({ enabled }: { enabled: boolean }) {
  const { sentinelRef, pastHero } = useScrolledPastHero(enabled);
  return (
    <div>
      <div ref={sentinelRef} id="sentinel" />
      <span id="state">{pastHero ? "past" : "top"}</span>
    </div>
  );
}

describe("useScrolledPastHero", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    ioCallback = null;
    observed.length = 0;
    disconnected = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    document.querySelectorAll(`[${HERO_MARKER_ATTR}]`).forEach((el) => el.remove());
    vi.unstubAllGlobals();
  });

  it("is false in SSR markup", () => {
    expect(renderToStaticMarkup(<Harness enabled />)).toContain(">top<");
  });

  it("observes the hero when one is on the page and flips when it leaves", () => {
    const hero = document.createElement("section");
    hero.setAttribute(HERO_MARKER_ATTR, "");
    document.body.appendChild(hero);
    root = createRoot(container);
    act(() => root!.render(<Harness enabled />));
    expect(observed).toEqual([hero]);
    act(() => ioCallback!([{ isIntersecting: true, target: hero }]));
    expect(container.querySelector("#state")!.textContent).toBe("top");
    act(() => ioCallback!([{ isIntersecting: false, target: hero }]));
    expect(container.querySelector("#state")!.textContent).toBe("past");
    act(() => ioCallback!([{ isIntersecting: true, target: hero }]));
    expect(container.querySelector("#state")!.textContent).toBe("top");
  });

  it("falls back to the sentinel when the page has no hero", () => {
    root = createRoot(container);
    act(() => root!.render(<Harness enabled />));
    expect(observed).toEqual([container.querySelector("#sentinel")]);
  });

  it("creates no observer when disabled and disconnects on unmount", () => {
    root = createRoot(container);
    act(() => root!.render(<Harness enabled={false} />));
    expect(observed).toEqual([]);
    act(() => root!.render(<Harness enabled />));
    expect(observed.length).toBe(1);
    act(() => root!.unmount());
    root = null;
    expect(disconnected).toBe(1);
  });

  it("stays false without IntersectionObserver support", () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", undefined);
    root = createRoot(container);
    act(() => root!.render(<Harness enabled />));
    expect(container.querySelector("#state")!.textContent).toBe("top");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run app/lib/useScrolledPastHero.test.tsx`
Expected: FAIL, "Failed to resolve import ./useScrolledPastHero".

- [ ] **Step 3: Write the hook**

Create `apps/web/app/lib/useScrolledPastHero.ts`:

```ts
import { useEffect, useRef, useState, type RefObject } from "react";

/** Attribute each hero variant puts on its root <section> so chrome can watch it. */
export const HERO_MARKER_ATTR = "data-pp-hero";

/**
 * True once the page's hero has scrolled out of view (and false again if the
 * visitor scrolls back up). Pages without a hero fall back to the sentinel
 * element this hook's ref is attached to, which the chrome sizes to one
 * viewport. Starts false on the server and on first paint, so the bottom bar
 * is never present in SSR markup; browsers without IntersectionObserver keep
 * the header CTA only.
 */
export function useScrolledPastHero(enabled: boolean): {
  sentinelRef: RefObject<HTMLDivElement>;
  pastHero: boolean;
} {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    if (typeof IntersectionObserver === "undefined") return;
    const target =
      document.querySelector<HTMLElement>(`[${HERO_MARKER_ATTR}]`) ?? sentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) setPastHero(!latest.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled]);

  return { sentinelRef, pastHero: enabled && pastHero };
}
```

- [ ] **Step 4: Run the hook test to verify it passes**

Run: `cd apps/web && npx vitest run app/lib/useScrolledPastHero.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing hero-marker test**

Append to `apps/web/app/components/site/sections/heroVariants.test.tsx`, inside the existing `describe("hero variants", ...)` block (the file already imports the three v3 heroes, `CommercialTemplate`, `makeTestCtx`, and mocks `Link`):

```tsx
  it("every hero variant carries the data-pp-hero marker on its root section", () => {
    const props = { ctx, density: "airy" as const, motif: "none" as const, motionClass: "" };
    const markups = [
      renderToStaticMarkup(<HeroSplitSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroEditorialSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroMinimalSection {...props} />),
    ];
    for (const markup of markups) {
      expect(markup.startsWith("<section")).toBe(true);
      expect(markup.slice(0, markup.indexOf(">"))).toContain("data-pp-hero");
    }
  });
```

Also add, in the same file, a check that the legacy hero has it. `HeroSection` is not yet imported there; add `import { HeroSection } from "./HeroSection";` beside the other section imports and this test (its props are `{ ctx; centered: boolean; minH: "screen" | "tall"; motionClass?; parallax? }`):

```tsx
  it("the legacy full-bleed hero carries the marker too", () => {
    const markup = renderToStaticMarkup(<HeroSection ctx={ctx} centered={false} minH="tall" />);
    expect(markup.slice(0, markup.indexOf(">"))).toContain("data-pp-hero");
  });
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/web && npx vitest run app/components/site/sections/heroVariants.test.tsx`
Expected: the two new tests FAIL on the `data-pp-hero` expectation; existing tests still pass.

- [ ] **Step 7: Add the marker to the four hero roots**

In each file, add `data-pp-hero` to the root `<section>` opening tag. The attribute is boolean-valued in React (`data-pp-hero=""`), written as `data-pp-hero=""` explicitly so the rendered attribute is stable:

`HeroSection.tsx` line 22, before: 
```tsx
    <section className={`relative flex ${minHClass} flex-col overflow-hidden${motionClass ? ` ${motionClass}` : ""}`}>
```
after:
```tsx
    <section data-pp-hero="" className={`relative flex ${minHClass} flex-col overflow-hidden${motionClass ? ` ${motionClass}` : ""}`}>
```

`HeroSplitSection.tsx` line 26: `<section data-pp-hero="" className={`relative overflow-hidden${...}`}>`

`HeroEditorialSection.tsx` line 26: `<section data-pp-hero="" className={`relative overflow-hidden px-4 md:px-6 ${pad}${...}`}>`

`HeroMinimalSection.tsx` line 21: `<section data-pp-hero="" className={`relative flex min-h-[85vh] ...`}>`

- [ ] **Step 8: Run the hero tests plus the parity suites**

Run: `cd apps/web && npx vitest run app/components/site/sections/heroVariants.test.tsx app/components/site/renderParity.test.tsx app/components/site/seededSweep.test.tsx app/components/site/imageAwareVariants.test.tsx`
Expected: all PASS (parity holds because the legacy and v3 paths render the same `HeroSection`).

- [ ] **Step 9: Type-check and commit**

Run: `cd apps/web && npx tsc && npm run lint`
Expected: no output from tsc; lint clean.

```bash
git add apps/web/app/lib/useScrolledPastHero.ts apps/web/app/lib/useScrolledPastHero.test.tsx apps/web/app/components/site/sections/HeroSection.tsx apps/web/app/components/site/sections/HeroSplitSection.tsx apps/web/app/components/site/sections/HeroEditorialSection.tsx apps/web/app/components/site/sections/HeroMinimalSection.tsx apps/web/app/components/site/sections/heroVariants.test.tsx
git commit -m "feat(site): useScrolledPastHero hook and data-pp-hero markers for the mobile booking bar" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 2: `MobileBookingBar` component + `shop-chrome.css`

**Files:**
- Create: `apps/web/app/components/MobileBookingBar.tsx`
- Create: `apps/web/app/components/MobileBookingBar.test.tsx`
- Create: `apps/web/app/components/shop-chrome.css`

**Interfaces:**
- Produces: `MobileBookingBar({ shopSlug, bookingEnabled, visible }: { shopSlug: string; bookingEnabled: boolean; visible: boolean })`. CSS classes `pp-bottom-bar`, `pp-bar-sentinel`, `pp-bar-shown`, `pp-safe-top`, `pp-safe-bottom`, `pp-safe-x`, `pp-chat-fab`, `pp-chat-panel`. Tasks 3, 6, 7 consume these.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/MobileBookingBar.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
  };
});

import { MobileBookingBar } from "./MobileBookingBar";

describe("MobileBookingBar", () => {
  it("links to the booking page and is hidden, untabbable and aria-hidden until visible", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled visible={false} />,
    );
    expect(html).toContain('href="/test-shop/book"');
    expect(html).toContain("Book now");
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("md:hidden");
  });

  it("is visible, tabbable and exposed once past the hero", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled visible />,
    );
    expect(html).toContain('data-visible="true"');
    expect(html).not.toContain("aria-hidden");
    expect(html).not.toContain("tabindex");
  });

  it("offers the services anchor when booking is disabled", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled={false} visible />,
    );
    expect(html).toContain('href="/test-shop#services"');
    expect(html).toContain("View services");
    expect(html).not.toContain("Book now");
  });

  it("uses theme tokens and a 48px target with press feedback", () => {
    const html = renderToStaticMarkup(
      <MobileBookingBar shopSlug="test-shop" bookingEnabled visible />,
    );
    expect(html).toContain("min-h-12");
    expect(html).toContain("bg-[color:var(--color-accent)]");
    expect(html).toContain("text-[color:var(--st-on-accent)]");
    expect(html).toContain("active:scale-[0.98]");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run app/components/MobileBookingBar.test.tsx`
Expected: FAIL, cannot resolve `./MobileBookingBar`.

- [ ] **Step 3: Write the component**

Create `apps/web/app/components/MobileBookingBar.tsx`:

```tsx
import { Link } from "@remix-run/react";

/**
 * Thumb-reach booking CTA for phones. Fixed to the bottom edge, safe-area
 * aware (see shop-chrome.css), hidden from md up. `visible` is driven by
 * useScrolledPastHero in the chrome: the bar slides in once the hero has
 * scrolled away. While hidden it is aria-hidden and out of the tab order so
 * keyboard and screen-reader users never land on an invisible control.
 */
export function MobileBookingBar({
  shopSlug,
  bookingEnabled,
  visible,
}: {
  shopSlug: string;
  bookingEnabled: boolean;
  visible: boolean;
}) {
  const to = bookingEnabled ? `/${shopSlug}/book` : `/${shopSlug}#services`;
  const label = bookingEnabled ? "Book now" : "View services";
  return (
    <div
      className="pp-bottom-bar md:hidden"
      data-visible={visible ? "true" : "false"}
      aria-hidden={visible ? undefined : true}
    >
      <Link
        to={to}
        tabIndex={visible ? undefined : -1}
        className="flex min-h-12 w-full items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-6 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-black/20 transition active:scale-[0.98]"
      >
        {label} →
      </Link>
    </div>
  );
}
```

- [ ] **Step 4: Write the stylesheet**

Create `apps/web/app/components/shop-chrome.css`:

```css
/* Shop chrome (Site Design v3, PR 3: native feel). Imported by
   CommercialShopChrome.tsx, so every shop page (landing, book, confirm,
   legal, waitlist) gets these rules. */

/* Safe areas. The body's standalone-mode padding (tailwind.css) only moves
   in-flow content; fixed and sticky chrome sits at the viewport edge and has
   to pad itself. env() is 0 on devices without insets. An element that also
   wants a padding floor of its own sets --pp-pad-* (Tailwind arbitrary
   property, e.g. [--pp-pad-x:1rem]) instead of a Tailwind padding class on
   the same side, so the two stylesheets never fight over one property. */
.pp-safe-top {
  padding-top: max(var(--pp-pad-top, 0px), env(safe-area-inset-top, 0px));
}
.pp-safe-bottom {
  padding-bottom: max(var(--pp-pad-bottom, 0px), env(safe-area-inset-bottom, 0px));
}
.pp-safe-x {
  padding-left: max(var(--pp-pad-x, 0px), env(safe-area-inset-left, 0px));
  padding-right: max(var(--pp-pad-x, 0px), env(safe-area-inset-right, 0px));
}

/* First-viewport sentinel: what the bottom bar watches on pages that have no
   hero. Absolute inside the chrome root, so it takes no layout space. svh
   tracks the visible viewport on phones; vh is the fallback. */
.pp-bar-sentinel {
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 100vh;
  height: 100svh;
  pointer-events: none;
}

/* Bottom booking bar. Starts off-screen and invisible; JS flips data-visible
   once the hero has scrolled away. `visibility` keeps the hidden bar out of
   the tab order and the accessibility tree; its transition is delayed so the
   slide-out is still seen. */
.pp-bottom-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  padding-top: 0.75rem;
  padding-bottom: max(0.75rem, env(safe-area-inset-bottom, 0px));
  padding-left: max(1rem, env(safe-area-inset-left, 0px));
  padding-right: max(1rem, env(safe-area-inset-right, 0px));
  border-top: 1px solid var(--st-line-10);
  background: var(--st-header);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  transform: translateY(100%);
  visibility: hidden;
  transition:
    transform 250ms ease-out,
    visibility 0s linear 250ms;
}
.pp-bottom-bar[data-visible="true"] {
  transform: none;
  visibility: visible;
  transition:
    transform 250ms ease-out,
    visibility 0s;
}

/* How far the chat launcher and panel rise while the bar is showing. The bar
   is display:none from md up (Tailwind md:hidden), so the lift is zero there. */
.pp-commercial {
  --pp-bar-lift: 0px;
}
.pp-bar-shown {
  --pp-bar-lift: 4.75rem;
}
@media (min-width: 768px) {
  .pp-bar-shown {
    --pp-bar-lift: 0px;
  }
}

/* Chat launcher and panel: positioned here (not with Tailwind bottom-*/right-*
   classes) so the safe-area inset and the bar lift compose in one place. */
.pp-chat-fab {
  position: fixed;
  z-index: 60;
  right: max(1.5rem, env(safe-area-inset-right, 0px));
  bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px) + var(--pp-bar-lift));
  transition: bottom 250ms ease-out;
}
.pp-chat-panel {
  position: fixed;
  z-index: 60;
  right: max(1.5rem, env(safe-area-inset-right, 0px));
  bottom: calc(6rem + env(safe-area-inset-bottom, 0px) + var(--pp-bar-lift));
  height: min(480px, calc(100vh - 7.5rem - env(safe-area-inset-bottom, 0px) - var(--pp-bar-lift)));
  overscroll-behavior: contain;
}

@media (prefers-reduced-motion: reduce) {
  .pp-bottom-bar,
  .pp-chat-fab {
    transition: none;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run app/components/MobileBookingBar.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/components/MobileBookingBar.tsx apps/web/app/components/MobileBookingBar.test.tsx apps/web/app/components/shop-chrome.css
git commit -m "feat(site): MobileBookingBar component and shop-chrome stylesheet" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 3: Wire the bar into the chrome; suppress it on booking flows

**Files:**
- Modify: `apps/web/app/components/CommercialShopChrome.tsx` (imports at lines 1-17; props type at 116-127; component signature 129-136; root `<div>` at ~321; `<style>` at ~325; `{children}` at ~535; bar placement after `<ShopSiteCookieConsent>` at ~735)
- Modify: `apps/web/app/routes/$shopSlug.book.tsx:140-146`
- Modify: `apps/web/app/routes/$shopSlug.confirm.tsx:58-66`
- Modify: `apps/web/app/routes/$shopSlug.waitlist.tsx:92-98`
- Create: `apps/web/app/components/CommercialShopChrome.test.tsx`

**Interfaces:**
- Consumes: `useScrolledPastHero`, `MobileBookingBar`, `shop-chrome.css` (Tasks 1, 2).
- Produces: new optional prop `bookingBar?: boolean` (default `true`) on `CommercialShopChromeProps`; root div gains `relative` and toggles `pp-bar-shown`. Tasks 6, 7, 8 extend the test file created here.

- [ ] **Step 1: Write the failing chrome SSR test**

Create `apps/web/app/components/CommercialShopChrome.test.tsx`:

```tsx
/** CommercialShopChrome SSR contract for the native-feel surfaces. Rendering
 *  with renderToStaticMarkup runs no effects, which is exactly the no-JS /
 *  pre-hydration markup real visitors get first. */
import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
  };
});
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { MessageCircle: Icon, X: Icon, Download: Icon };
});

import { CommercialShopChrome } from "./CommercialShopChrome";

const site = { shop_id: "shop-1", shop_name: "Test Shop", tagline: "", design_version: 3 };

function render(props: Partial<ComponentProps<typeof CommercialShopChrome>> = {}) {
  return renderToStaticMarkup(
    <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop" {...props}>
      <main>content</main>
    </CommercialShopChrome>,
  );
}

describe("CommercialShopChrome: mobile booking bar", () => {
  it("renders the bar hidden by default, plus the first-viewport sentinel", () => {
    const html = render();
    expect(html).toContain('class="pp-bottom-bar md:hidden"');
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('href="/test-shop/book"');
    expect(html).toContain("pp-bar-sentinel");
    expect(html).not.toContain("pp-bar-shown");
  });

  it("omits the bar entirely when bookingBar is false", () => {
    const html = render({ bookingBar: false });
    expect(html).not.toContain("pp-bottom-bar");
    expect(html).not.toContain("pp-bar-sentinel");
  });

  it("points the bar at services when booking is disabled", () => {
    const html = render({ settings: { booking_enabled: false } });
    expect(html).toContain("View services");
    expect(html).toContain('href="/test-shop#services"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run app/components/CommercialShopChrome.test.tsx`
Expected: FAIL on `pp-bottom-bar` / `pp-bar-sentinel` expectations (the component renders but has none of the new markup). If it fails earlier on the `lucide-react` mock (an icon name missing), add the missing name to the mock; `Download` is used from Task 6 onward and is harmless now.

- [ ] **Step 3: Add the imports, prop, hook and markup to the chrome**

In `apps/web/app/components/CommercialShopChrome.tsx`:

(a) Imports. After `import { useModalA11y } from "~/lib/useModalA11y";` add:

```tsx
import { useScrolledPastHero } from "~/lib/useScrolledPastHero";
import { MobileBookingBar } from "~/components/MobileBookingBar";
import "~/components/shop-chrome.css";
```

(b) Props. In `CommercialShopChromeProps` add, after `services?`:

```tsx
  /**
   * Render the phone-only sticky "Book now" bar (default true). Pages whose
   * own flow owns the primary CTA (/book, /confirm, /waitlist) pass false.
   */
  bookingBar?: boolean;
```

(c) Signature. Destructure it: change

```tsx
  children,
  services = [],
}: CommercialShopChromeProps) {
```
to
```tsx
  children,
  services = [],
  bookingBar = true,
}: CommercialShopChromeProps) {
```

(d) Hook. Directly after `const bookingEnabled = settings.booking_enabled !== false;` add:

```tsx
  // Phone-only bottom bar: shown once the hero (or the first viewport, on
  // pages without one) has scrolled away. Never present in SSR markup.
  const { sentinelRef, pastHero } = useScrolledPastHero(bookingBar);
```

(e) Root div. Change

```tsx
    <div
      className="pp-commercial min-h-screen bg-[color:var(--st-bg)] text-[color:var(--st-ink)]"
      style={{ ...rootStyle, fontFamily: "var(--pp-font-body)" }}
    >
```
to
```tsx
    <div
      className={`pp-commercial relative min-h-screen bg-[color:var(--st-bg)] text-[color:var(--st-ink)]${pastHero ? " pp-bar-shown" : ""}`}
      style={{ ...rootStyle, fontFamily: "var(--pp-font-body)" }}
    >
```

(`relative` only anchors the absolute sentinel; it does not affect fixed descendants.)

(f) Sentinel. Immediately after the closing `/>` of the `<style dangerouslySetInnerHTML=... />` element, before `<header`, add:

```tsx
      {bookingBar ? <div ref={sentinelRef} className="pp-bar-sentinel" aria-hidden /> : null}
```

(g) Bar. After the `<ShopSiteCookieConsent ... />` element and before `{chatOpen ? (` add:

```tsx
      {bookingBar ? (
        <MobileBookingBar shopSlug={shopSlug} bookingEnabled={bookingEnabled} visible={pastHero} />
      ) : null}
```

- [ ] **Step 4: Opt the booking flows out**

`apps/web/app/routes/$shopSlug.book.tsx` (line ~140):
```tsx
      <CommercialShopChrome
        site={siteDataForChrome(layoutData.shop.name, site, layoutData.shop.id)}
        settings={layoutData.settings ?? {}}
        shopSlug={layoutData.slug}
        bookingBar={false}
      >
```

`apps/web/app/routes/$shopSlug.confirm.tsx` (line ~60, inside `ConfirmShell`): same four-prop shape with `bookingBar={false}`.

`apps/web/app/routes/$shopSlug.waitlist.tsx` (line ~92): same, `bookingBar={false}`.

- [ ] **Step 5: Run the chrome test and the whole web suite**

Run: `cd apps/web && npx vitest run app/components/CommercialShopChrome.test.tsx && npm test`
Expected: chrome test PASS (3 tests); full suite green (the section tests mock the chrome, so they are unaffected).

- [ ] **Step 6: Type-check, lint, build, commit**

Run: `cd apps/web && npx tsc && npm run lint && npm run build`
Expected: all clean; the build proves the CSS side-effect import resolves under Remix Vite (same mechanism as `motion.css`).

```bash
git add apps/web/app/components/CommercialShopChrome.tsx apps/web/app/components/CommercialShopChrome.test.tsx "apps/web/app/routes/\$shopSlug.book.tsx" "apps/web/app/routes/\$shopSlug.confirm.tsx" "apps/web/app/routes/\$shopSlug.waitlist.tsx"
git commit -m "feat(site): sticky mobile booking bar in the shop chrome, suppressed on booking flows" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 4: Install capability store (`lib/installPrompt.ts`)

**Files:**
- Create: `apps/web/app/lib/installPrompt.ts`
- Create: `apps/web/app/lib/installPrompt.test.ts`

**Interfaces:**
- Produces:
  - `type InstallMode = "unavailable" | "native" | "ios" | "installed"`
  - `getInstallMode(): InstallMode`, `isInstallGuideOpen(): boolean`, `subscribeInstall(listener: () => void): () => void`
  - `promptInstall(): Promise<"accepted" | "dismissed" | "unavailable">`
  - `requestInstall(): void` (native prompt where available, else opens the iOS guide)
  - `openInstallGuide(): void`, `closeInstallGuide(): void`
  - `useInstallMode(): InstallMode`, `useInstallGuideOpen(): boolean` (both `useSyncExternalStore`, server snapshot `"unavailable"` / `false`)
- Tasks 5 and 6 consume these.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/lib/installPrompt.test.ts`:

```ts
/** installPrompt store: captures beforeinstallprompt at module load, reports
 *  the device's install mode, drives the native prompt and the iOS guide. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Store = typeof import("./installPrompt");

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

function fakePromptEvent(outcome: "accepted" | "dismissed") {
  const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  ev.prompt = vi.fn(async () => {});
  ev.userChoice = Promise.resolve({ outcome });
  return ev;
}

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import("./installPrompt");
}

describe("installPrompt store", () => {
  beforeEach(() => {
    setUserAgent(CHROME_UA);
  });
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("starts unavailable on a browser that has not offered to install", async () => {
    const store = await freshStore();
    expect(store.getInstallMode()).toBe("unavailable");
    expect(store.isInstallGuideOpen()).toBe(false);
  });

  it("captures beforeinstallprompt (preventing the default mini-infobar) and reports native", async () => {
    const store = await freshStore();
    const seen = vi.fn();
    store.subscribeInstall(seen);
    const ev = fakePromptEvent("accepted");
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(store.getInstallMode()).toBe("native");
    expect(seen).toHaveBeenCalled();
  });

  it("promptInstall shows the native dialog once; accepting flips to installed", async () => {
    const store = await freshStore();
    const ev = fakePromptEvent("accepted");
    window.dispatchEvent(ev);
    await expect(store.promptInstall()).resolves.toBe("accepted");
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    expect(store.getInstallMode()).toBe("installed");
    await expect(store.promptInstall()).resolves.toBe("unavailable");
  });

  it("a dismissed native dialog consumes the event and returns to unavailable", async () => {
    const store = await freshStore();
    window.dispatchEvent(fakePromptEvent("dismissed"));
    await expect(store.promptInstall()).resolves.toBe("dismissed");
    expect(store.getInstallMode()).toBe("unavailable");
  });

  it("reports ios on iPhone Safari and requestInstall opens the guide there", async () => {
    setUserAgent(IOS_UA);
    const store = await freshStore();
    expect(store.getInstallMode()).toBe("ios");
    store.requestInstall();
    expect(store.isInstallGuideOpen()).toBe(true);
    store.closeInstallGuide();
    expect(store.isInstallGuideOpen()).toBe(false);
  });

  it("requestInstall prompts natively when a prompt was captured", async () => {
    const store = await freshStore();
    const ev = fakePromptEvent("accepted");
    window.dispatchEvent(ev);
    store.requestInstall();
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    expect(store.isInstallGuideOpen()).toBe(false);
  });

  it("reports installed when already running standalone", async () => {
    Object.defineProperty(window, "matchMedia", {
      value: () => ({ matches: true }),
      configurable: true,
      writable: true,
    });
    const store = await freshStore();
    expect(store.getInstallMode()).toBe("installed");
  });

  it("appinstalled flips to installed", async () => {
    const store = await freshStore();
    window.dispatchEvent(fakePromptEvent("accepted"));
    window.dispatchEvent(new Event("appinstalled"));
    expect(store.getInstallMode()).toBe("installed");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run app/lib/installPrompt.test.ts`
Expected: FAIL, cannot resolve `./installPrompt`.

- [ ] **Step 3: Write the store**

Create `apps/web/app/lib/installPrompt.ts`:

```ts
import { useSyncExternalStore } from "react";

/**
 * Install capability for the per-shop PWA, shared by every install surface
 * (root InstallAppPrompt invitation, the shop mobile-menu row, the booking
 * confirmation chip). Chromium fires `beforeinstallprompt` ONCE, early; the
 * listener below registers when this module first evaluates in the browser,
 * which is earlier than any component effect, so the event is captured even
 * if it fires before hydration finishes. iOS Safari has no install API, so
 * "ios" means "show the Share -> Add to Home Screen walkthrough".
 *
 * Standing decisions honoured here: no service worker; no platform-mimicking
 * UI; the per-shop manifest already makes the shop the installed app.
 */

export type InstallMode = "unavailable" | "native" | "ios" | "installed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let guideOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const query =
    typeof window.matchMedia === "function" ? window.matchMedia("(display-mode: standalone)") : null;
  return (
    query?.matches === true ||
    // iOS Safari's pre-standard flag
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as macOS but is the only Mac with touch
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isIos && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** Current install mode, computed from the environment on every call (cheap,
 *  and the string result is stable by value for useSyncExternalStore). */
export function getInstallMode(): InstallMode {
  if (typeof window === "undefined") return "unavailable";
  if (installed || isStandalone()) return "installed";
  if (deferred) return "native";
  if (isIosSafari()) return "ios";
  return "unavailable";
}

export function isInstallGuideOpen(): boolean {
  return guideOpen;
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openInstallGuide(): void {
  guideOpen = true;
  emit();
}

export function closeInstallGuide(): void {
  guideOpen = false;
  emit();
}

/** Show the browser's native install dialog. Chromium allows one prompt() per
 *  captured event, so the event is consumed up front whatever the outcome. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = null;
  emit();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === "accepted") installed = true;
  emit();
  return outcome;
}

/** The one call install surfaces make: native prompt where captured, the iOS
 *  walkthrough otherwise, nothing when the device cannot install. */
export function requestInstall(): void {
  const mode = getInstallMode();
  if (mode === "native") void promptInstall();
  else if (mode === "ios") openInstallGuide();
}

const serverMode = (): InstallMode => "unavailable";
const serverGuide = (): boolean => false;

export function useInstallMode(): InstallMode {
  return useSyncExternalStore(subscribeInstall, getInstallMode, serverMode);
}

export function useInstallGuideOpen(): boolean {
  return useSyncExternalStore(subscribeInstall, isInstallGuideOpen, serverGuide);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run app/lib/installPrompt.test.ts`
Expected: PASS, 8 tests. (Listeners from earlier module instances stay attached to the shared jsdom window after `vi.resetModules()`; they only update their own dead module state and cannot affect assertions.)

- [ ] **Step 5: Type-check and commit**

Run: `cd apps/web && npx tsc && npm run lint`

```bash
git add apps/web/app/lib/installPrompt.ts apps/web/app/lib/installPrompt.test.ts
git commit -m "feat(web): shared install-capability store for the per-shop PWA" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 5: `InstallAppPrompt` on the store, with an on-demand guide mode

**Files:**
- Modify: `apps/web/app/components/InstallAppPrompt.tsx` (whole file; the JSX from `return (` to the end is kept verbatim except where noted)
- Create: `apps/web/app/components/InstallAppPrompt.test.tsx`

**Interfaces:**
- Consumes: `useInstallMode`, `useInstallGuideOpen`, `promptInstall`, `closeInstallGuide` (Task 4).
- Produces: unchanged export `InstallAppPrompt()` (root-mounted in `root.tsx`; no change there). Behaviour: the unprompted invitation is unchanged (1.5s delay, once per device via `pp-install-dismissed`); additionally the dialog opens immediately in iOS-guide form whenever `openInstallGuide()` is called, regardless of the dismissal memory.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/InstallAppPrompt.test.tsx`:

```tsx
/** InstallAppPrompt: unprompted invitation (delayed, once per device) plus the
 *  on-demand iOS guide opened by the install surfaces. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { Download: Icon, Share: Icon, SquarePlus: Icon, X: Icon };
});
vi.mock("~/lib/shop-match", () => ({
  useShopMatch: () => ({ slug: "test-shop", name: "Test Shop" }),
}));

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

function fakePromptEvent(outcome: "accepted" | "dismissed") {
  const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  ev.prompt = vi.fn(async () => {});
  ev.userChoice = Promise.resolve({ outcome });
  return ev;
}

async function mount() {
  vi.resetModules();
  const store = await import("~/lib/installPrompt");
  const { InstallAppPrompt } = await import("./InstallAppPrompt");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<InstallAppPrompt />));
  return { store, root, container };
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!btn) throw new Error(`no button containing "${text}"`);
  return btn;
}

describe("InstallAppPrompt", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    setUserAgent(CHROME_UA);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.useRealTimers();
  });

  it("renders nothing when the device cannot install", async () => {
    ({ root, container } = await mount());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container!.innerHTML).toBe("");
  });

  it("invites after the delay once a prompt is captured, and Not now is remembered", async () => {
    const m = await mount();
    ({ root, container } = m);
    act(() => {
      window.dispatchEvent(fakePromptEvent("accepted"));
    });
    expect(container!.innerHTML).toBe("");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(container!.textContent).toContain("Get the Test Shop app");
    expect(container!.textContent).toContain("Install app");
    click(buttonByText(container!, "Not now"));
    expect(container!.innerHTML).toBe("");
    expect(localStorage.getItem("pp-install-dismissed")).not.toBeNull();
  });

  it("does not invite again once dismissed, but the on-demand guide still opens", async () => {
    setUserAgent(IOS_UA);
    localStorage.setItem("pp-install-dismissed", "2026-09-01T00:00:00.000Z");
    const m = await mount();
    ({ root, container } = m);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(container!.innerHTML).toBe("");
    act(() => {
      m.store.openInstallGuide();
    });
    expect(container!.textContent).toContain("Add to Home Screen");
    click(buttonByText(container!, "Got it"));
    expect(container!.innerHTML).toBe("");
    expect(m.store.isInstallGuideOpen()).toBe(false);
  });

  it("Install app runs the native prompt", async () => {
    const m = await mount();
    ({ root, container } = m);
    const ev = fakePromptEvent("accepted");
    act(() => {
      window.dispatchEvent(ev);
      vi.advanceTimersByTime(1500);
    });
    click(buttonByText(container!, "Install app"));
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    // Flush the prompt's promise continuations inside act so React's
    // "update not wrapped in act" warning cannot fire after the test ends.
    await act(async () => {});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run app/components/InstallAppPrompt.test.tsx`
Expected: the third test FAILS (the guide cannot be opened on demand today; `m.store.openInstallGuide` exists from Task 4 but the component ignores it). Tests 1, 2, 4 may pass against the old implementation; that is fine.

- [ ] **Step 3: Rewrite the component's logic on the store**

Replace everything in `apps/web/app/components/InstallAppPrompt.tsx` from the top of the file down to (not including) the line `  return (` with:

```tsx
import { useEffect, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { useShopMatch } from "~/lib/shop-match";
import { useModalA11y } from "~/lib/useModalA11y";
import {
  closeInstallGuide,
  promptInstall,
  useInstallGuideOpen,
  useInstallMode,
} from "~/lib/installPrompt";

/**
 * Centered "install the app" dialog with two ways in:
 *
 * 1. The unprompted invitation: shown once per device (until dismissed or
 *    installed), after a short delay so it never competes with first paint.
 *    Chromium shows an Install button (native prompt); iOS/iPadOS Safari has
 *    no install API, so it shows the Share -> Add to Home Screen walkthrough.
 * 2. On demand: the shop menu's "Install this shop's app" row and the
 *    booking-confirmation chip call requestInstall(); on iOS that opens this
 *    dialog in walkthrough form immediately, ignoring any earlier "Not now".
 *
 * Install capability itself (event capture, mode detection, the prompt) lives
 * in lib/installPrompt so every surface shares one captured event. Renders
 * nothing during SSR and in installed (standalone) mode.
 */

const DISMISS_KEY = "pp-install-dismissed";
const SHOW_DELAY_MS = 1500;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) !== null;
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
  } catch {
    /* storage blocked: the invitation simply shows again next visit */
  }
}

export function InstallAppPrompt() {
  // On a shop site the install captures the SHOP's app (per-shop manifest),
  // so the invitation carries the shop's name, not the platform's.
  const shop = useShopMatch();
  const mode = useInstallMode();
  const guideOpen = useInstallGuideOpen();
  const [invite, setInvite] = useState(false);

  const installable = mode === "native" || mode === "ios";

  useEffect(() => {
    if (!installable || readDismissed()) return;
    const timer = setTimeout(() => setInvite(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [installable]);

  const open = guideOpen || (invite && installable);

  function dismiss() {
    // Only the unprompted invitation is remembered; closing the on-demand
    // guide must not silence a future explicit tap.
    if (invite) {
      writeDismissed();
      setInvite(false);
    }
    if (guideOpen) closeInstallGuide();
  }

  async function install() {
    const outcome = await promptInstall();
    if (outcome === "dismissed") {
      // Declining the native dialog counts as "not now".
      writeDismissed();
      setInvite(false);
    }
    if (guideOpen) closeInstallGuide();
  }

  // Focus trap, focus-in, Escape-to-close, scroll-lock and focus-restore.
  const dialogRef = useModalA11y<HTMLDivElement>({
    active: open,
    onClose: dismiss,
  });

  if (!open) return null;

```

Then, in the JSX that follows, change the branch condition `{mode === "native" ? (` to exactly the same text (it already reads `mode === "native"`; the variable now comes from the store). Every `onClick={dismiss}` and `onClick={install}` stays as is. Delete nothing else.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run app/components/InstallAppPrompt.test.tsx app/lib/installPrompt.test.ts`
Expected: PASS, 4 + 8 tests.

- [ ] **Step 5: Type-check, lint, commit**

Run: `cd apps/web && npx tsc && npm run lint`

```bash
git add apps/web/app/components/InstallAppPrompt.tsx apps/web/app/components/InstallAppPrompt.test.tsx
git commit -m "refactor(web): InstallAppPrompt reads the shared install store and opens on demand" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 6: `InstallAppButton` + the two install surfaces

**Files:**
- Create: `apps/web/app/components/InstallAppButton.tsx`
- Create: `apps/web/app/components/InstallAppButton.test.tsx`
- Modify: `apps/web/app/components/CommercialShopChrome.tsx` (mobile menu `<nav aria-label="Mobile">`, the "Sign in" `<Link>` at ~line 510)
- Modify: `apps/web/app/routes/$shopSlug.confirm.tsx` (confirmed branch, ~lines 155-183)
- Modify: `apps/web/app/components/CommercialShopChrome.test.tsx` (append a client-render block)

**Interfaces:**
- Consumes: `useInstallMode`, `requestInstall` (Task 4).
- Produces: `InstallAppButton({ shopName, look, onActivate?, className? }: { shopName: string; look: "row" | "chip"; onActivate?: () => void; className?: string })`. Renders `null` unless the device can install.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/InstallAppButton.test.tsx`:

```tsx
/** InstallAppButton: nothing on the server or on non-installable devices; a
 *  labelled button that triggers the shared install flow otherwise. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("lucide-react", () => ({ Download: () => null }));

const CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";

function fakePromptEvent() {
  const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  ev.prompt = vi.fn(async () => {});
  ev.userChoice = Promise.resolve({ outcome: "accepted" as const });
  return ev;
}

async function load() {
  vi.resetModules();
  const store = await import("~/lib/installPrompt");
  const { InstallAppButton } = await import("./InstallAppButton");
  return { store, InstallAppButton };
}

describe("InstallAppButton", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    Object.defineProperty(window.navigator, "userAgent", { value: CHROME_UA, configurable: true });
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
  });

  it("renders nothing in SSR markup", async () => {
    const { InstallAppButton } = await load();
    expect(renderToStaticMarkup(<InstallAppButton shopName="Test Shop" look="row" />)).toBe("");
    expect(renderToStaticMarkup(<InstallAppButton shopName="Test Shop" look="chip" />)).toBe("");
  });

  it("renders nothing on a device that cannot install", async () => {
    const { InstallAppButton } = await load();
    root = createRoot(container);
    act(() => root!.render(<InstallAppButton shopName="Test Shop" look="row" />));
    expect(container.innerHTML).toBe("");
  });

  it("row: appears once a prompt is captured, calls onActivate then prompts", async () => {
    const { InstallAppButton } = await load();
    const ev = fakePromptEvent();
    const onActivate = vi.fn();
    root = createRoot(container);
    act(() => root!.render(<InstallAppButton shopName="Test Shop" look="row" onActivate={onActivate} />));
    act(() => {
      window.dispatchEvent(ev);
    });
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("Install this shop's app");
    expect(btn.className).toContain("min-h-12");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it("chip: names the shop and takes an extra class", async () => {
    const { InstallAppButton } = await load();
    root = createRoot(container);
    act(() => root!.render(<InstallAppButton shopName="Test Shop" look="chip" className="mt-6" />));
    act(() => {
      window.dispatchEvent(fakePromptEvent());
    });
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("Add Test Shop to your home screen");
    expect(btn.className).toContain("mt-6");
    expect(btn.className).toContain("active:scale-[0.98]");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run app/components/InstallAppButton.test.tsx`
Expected: FAIL, cannot resolve `./InstallAppButton`.

- [ ] **Step 3: Write the component**

Create `apps/web/app/components/InstallAppButton.tsx`:

```tsx
import { Download } from "lucide-react";
import { requestInstall, useInstallMode } from "~/lib/installPrompt";

/**
 * Discoverable install entry for the shop's PWA. Two looks: a full-width
 * `row` for the shop mobile menu and an outlined `chip` for the booking
 * confirmation screen. Renders nothing on the server, on browsers that never
 * offered to install, and once installed, so no page changes shape unless
 * the device can actually act on it. Uses only --st-* tokens.
 */
export function InstallAppButton({
  shopName,
  look,
  onActivate,
  className = "",
}: {
  shopName: string;
  look: "row" | "chip";
  /** Runs before the install flow starts (the menu passes its close handler). */
  onActivate?: () => void;
  className?: string;
}) {
  const mode = useInstallMode();
  if (mode !== "native" && mode !== "ios") return null;

  const label = look === "row" ? "Install this shop's app" : `Add ${shopName} to your home screen`;
  const base =
    look === "row"
      ? "flex min-h-12 w-full items-center gap-3 rounded-[var(--st-r-sm)] px-4 py-3 text-left font-medium text-[color:var(--st-ink-90)] transition active:scale-[0.98]"
      : "inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--st-r-md)] border border-[color:var(--st-line-40)] px-5 text-sm font-semibold text-[color:var(--st-ink-90)] transition active:scale-[0.98]";

  return (
    <button
      type="button"
      className={className ? `${base} ${className}` : base}
      onClick={() => {
        onActivate?.();
        requestInstall();
      }}
    >
      <Download className="h-5 w-5 shrink-0 text-[color:var(--st-accent-text)]" aria-hidden />
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run app/components/InstallAppButton.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing chrome menu test**

Append to `apps/web/app/components/CommercialShopChrome.test.tsx` (the `lucide-react` mock at the top already stubs `Download`; add the act-environment flag as the FIRST line of the file, above the imports, exactly as in `reveal.test.tsx`):

```tsx
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
```

and add these imports beside the existing ones:

```tsx
import { act } from "react";
import { createRoot } from "react-dom/client";
```

then append the block:

```tsx
describe("CommercialShopChrome: install row in the mobile menu", () => {
  it("shows the row only once the device can install, and closes the menu on tap", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
      configurable: true,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <CommercialShopChrome site={site} settings={{}} shopSlug="test-shop">
          <main>content</main>
        </CommercialShopChrome>,
      ),
    );
    const openMenu = container.querySelector('button[aria-label="Open menu"]')!;
    act(() => {
      openMenu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Install this shop's app");

    const ev = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: () => Promise<void>;
      userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
    };
    ev.prompt = vi.fn(async () => {});
    ev.userChoice = Promise.resolve({ outcome: "accepted" as const });
    act(() => {
      window.dispatchEvent(ev);
    });
    const row = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Install this shop's app"),
    )!;
    expect(row).toBeTruthy();
    act(() => {
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"][aria-label="Menu"]')).toBeNull();
    expect(ev.prompt).toHaveBeenCalledTimes(1);
    await act(async () => {});

    act(() => root.unmount());
    container.remove();
  });
});
```

Run: `cd apps/web && npx vitest run app/components/CommercialShopChrome.test.tsx`
Expected: the new test FAILS at `expect(row).toBeTruthy()` (no row in the menu yet). If the client render throws on the Turnstile script effect, note that jsdom appends the `<script>` without fetching it; if it throws for another reason, report it rather than stubbing further.

- [ ] **Step 6: Add the row to the mobile menu**

In `CommercialShopChrome.tsx`, add the import beside the other component imports:

```tsx
import { InstallAppButton } from "~/components/InstallAppButton";
```

In the `<nav className="flex flex-1 flex-col gap-1 p-6" aria-label="Mobile">`, directly after the "Sign in" `<Link ...>Sign in</Link>` and before the `{bookingEnabled ? (` "Book Now →" button, add:

```tsx
            {/* Install entry for the shop's PWA; renders nothing unless this
                device can install. Closing the menu first lets the native
                dialog (or the iOS walkthrough in the root-mounted prompt)
                take focus cleanly. */}
            <InstallAppButton shopName={site.shop_name} look="row" onActivate={closeNav} />
```

- [ ] **Step 7: Add the chip to the confirmation screen**

In `apps/web/app/routes/$shopSlug.confirm.tsx`, add the import:

```tsx
import { InstallAppButton } from "~/components/InstallAppButton";
```

In the final `return (` (the confirmed state), directly after the `{bookingId && (<p ...>Ref: {bookingId}</p>)}` block and before `{shopAddress ? <BookingConfirmMap ... /> : null}`, add:

```tsx
      {/* Highest-intent install moment: the visitor has just booked here. */}
      <InstallAppButton
        shopName={layoutData?.shop?.name ?? "this shop"}
        look="chip"
        className="mt-6"
      />
```

(`ConfirmShell`'s inner wrapper is `text-center`, so the inline-flex chip centres itself; when the button renders `null` no spacing is added.)

- [ ] **Step 8: Run the tests, type-check, lint**

Run: `cd apps/web && npx vitest run app/components/CommercialShopChrome.test.tsx app/components/InstallAppButton.test.tsx && npx tsc && npm run lint`
Expected: PASS; tsc and lint clean.

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/components/InstallAppButton.tsx apps/web/app/components/InstallAppButton.test.tsx apps/web/app/components/CommercialShopChrome.tsx apps/web/app/components/CommercialShopChrome.test.tsx "apps/web/app/routes/\$shopSlug.confirm.tsx"
git commit -m "feat(site): install-this-shop's-app row in the mobile menu and chip on booking confirmation" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 7: Safe areas on every fixed or sticky shop surface

**Files:**
- Modify: `apps/web/app/components/CommercialShopChrome.tsx` (header ~line 350; mobile menu container ~line 467; chat panel ~lines 740-745; chat launcher ~lines 936-940)
- Modify: `apps/web/app/components/ShopSiteCookieConsent.tsx:90`
- Modify: `apps/web/app/components/CommercialShopChrome.test.tsx` (append)

**Interfaces:**
- Consumes: `pp-safe-top`, `pp-safe-bottom`, `pp-safe-x`, `pp-chat-fab`, `pp-chat-panel` (Task 2).

- [ ] **Step 1: Write the failing test**

Append to `CommercialShopChrome.test.tsx`:

```tsx
describe("CommercialShopChrome: safe areas", () => {
  it("pads the sticky header and positions the chat launcher through the shared classes", () => {
    const html = render();
    const headerTag = html.slice(html.indexOf("<header"), html.indexOf(">", html.indexOf("<header")));
    expect(headerTag).toContain("pp-safe-top");
    expect(headerTag).toContain("pp-safe-x");
    // The launcher's opening tag: class comes before aria-label in the JSX,
    // so take the whole <button ...> chunk that carries the label.
    const fabChunk = html.split("<button ").find((chunk) => chunk.includes('aria-label="Open chat"'))!;
    const fabTag = fabChunk.slice(0, fabChunk.indexOf(">"));
    expect(fabTag).toContain("pp-chat-fab");
    expect(fabTag).not.toContain("bottom-6");
    expect(fabTag).not.toContain("right-6");
  });
});
```

Run: `cd apps/web && npx vitest run app/components/CommercialShopChrome.test.tsx`
Expected: the new test FAILS on `pp-safe-top`.

- [ ] **Step 2: Apply the classes in the chrome**

(a) Header. Change
```tsx
      <header className="sticky top-0 z-40 border-b border-[color:var(--st-line-10)] bg-[color:var(--st-header)] backdrop-blur-md">
```
to
```tsx
      <header className="pp-safe-top pp-safe-x sticky top-0 z-40 border-b border-[color:var(--st-line-10)] bg-[color:var(--st-header)] backdrop-blur-md">
```

(b) Mobile menu container. Change
```tsx
          className="fixed inset-0 z-50 flex flex-col bg-[color:var(--st-bg)] md:hidden"
```
to
```tsx
          className="pp-safe-top pp-safe-bottom pp-safe-x fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-[color:var(--st-bg)] md:hidden"
```

(`overflow-y-auto overscroll-contain` is also the Task 8 overscroll requirement for the menu; it lands here because it is the same attribute edit.)

(c) Chat panel. Change
```tsx
          className="fixed bottom-24 right-6 z-[60] flex w-[360px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-15)] bg-[color:var(--st-bg)] shadow-2xl"
          style={{ height: 480, maxHeight: "min(480px, calc(100vh - 7.5rem))" }}
```
to
```tsx
          className="pp-chat-panel flex w-[360px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-15)] bg-[color:var(--st-bg)] shadow-2xl"
```
(the `style` prop is removed; height now comes from `.pp-chat-panel`).

(d) Chat launcher. Change
```tsx
        className="fixed bottom-6 right-6 z-[60] flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-[color:var(--color-accent)] text-[color:var(--st-on-accent)] shadow-xl transition hover:opacity-95"
```
to
```tsx
        className="pp-chat-fab flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-[color:var(--color-accent)] text-[color:var(--st-on-accent)] shadow-xl transition hover:opacity-95 active:scale-95"
```

- [ ] **Step 3: Cookie notice**

In `apps/web/app/components/ShopSiteCookieConsent.tsx` change
```tsx
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 p-4 shadow-2xl backdrop-blur-md md:p-6"
```
to
```tsx
      className="pp-safe-bottom pp-safe-x fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 p-4 shadow-2xl backdrop-blur-md md:p-6"
```

Ordering note: `.pp-safe-*` and Tailwind's `p-4` would both set padding on the shared sides, and whichever stylesheet loads later would win. The Task 2 rules avoid the fight by reading a `--pp-pad-*` floor instead, so the notice must NOT keep a Tailwind padding class on those sides. The exact class list is therefore:

```tsx
      className="pp-safe-bottom pp-safe-x fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 pt-4 [--pp-pad-bottom:1rem] [--pp-pad-x:1rem] shadow-2xl backdrop-blur-md md:pt-6 md:[--pp-pad-bottom:1.5rem] md:[--pp-pad-x:1.5rem]"
```

(Tailwind 3.4 arbitrary-property syntax; the notice keeps its 1rem / 1.5rem padding as the floor and grows only when an inset is larger.) The header and mobile menu need no floor (their inner elements carry `px-4` / `p-6`), so they use the classes bare.

- [ ] **Step 4: Run tests, type-check, lint, build**

Run: `cd apps/web && npx vitest run app/components/CommercialShopChrome.test.tsx && npm test && npx tsc && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/CommercialShopChrome.tsx apps/web/app/components/CommercialShopChrome.test.tsx apps/web/app/components/ShopSiteCookieConsent.tsx apps/web/app/components/shop-chrome.css
git commit -m "feat(site): safe-area padding on header, menu, chat, cookie notice; chat launcher lifts above the bar" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 8: Micro-feel: press feedback on primary CTAs, contained overscroll

**Files:**
- Modify: `apps/web/app/components/CommercialShopChrome.tsx` (desktop "Book Now →" and "View services →" ~lines 417-431; mobile header "Book" ~line 436-444; menu "Book Now →" / "View services →" ~lines 518-532; chat body `overflow-y-auto` div ~line 787)
- Modify: `apps/web/app/components/site/sections/HeroSection.tsx:73`, `HeroSplitSection.tsx:52`, `HeroEditorialSection.tsx:42`, `HeroMinimalSection.tsx:36`, `FinalCtaSection.tsx:13-16`
- Modify: `apps/web/app/components/site/sections/heroVariants.test.tsx` (append), `apps/web/app/components/CommercialShopChrome.test.tsx` (append)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests**

Append to `heroVariants.test.tsx`:

Add `import { FinalCtaSection } from "./FinalCtaSection";` beside the other section imports in `heroVariants.test.tsx`, then append inside the describe block:

```tsx
  it("primary booking CTAs give press feedback in every hero and the final CTA", () => {
    const props = { ctx, density: "airy" as const, motif: "none" as const, motionClass: "" };
    const pages = [
      renderToStaticMarkup(<HeroSection ctx={ctx} centered={false} minH="tall" />),
      renderToStaticMarkup(<HeroSplitSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroEditorialSection {...props} parallax={false} />),
      renderToStaticMarkup(<HeroMinimalSection {...props} />),
      renderToStaticMarkup(<FinalCtaSection ctx={ctx} glow={false} />),
    ];
    for (const html of pages) {
      // `to` precedes `className` in the JSX, so href comes first in the tag
      // and the class list follows it up to the closing ">".
      const start = html.indexOf('href="/test-shop/book"');
      expect(start).toBeGreaterThan(-1);
      const tag = html.slice(start, html.indexOf(">", start));
      expect(tag).toContain("active:scale-[0.98]");
    }
  });
```

Append to `CommercialShopChrome.test.tsx`:

```tsx
describe("CommercialShopChrome: press feedback", () => {
  it("every accent-filled booking CTA in the server markup carries the press state", () => {
    const html = render();
    // Server markup holds four /book anchors: the desktop nav text link
    // "Book", the desktop "Book Now →" button, the mobile header "Book"
    // button, and the bottom bar. Only the accent-filled buttons are
    // primary CTAs; the nav text link is not one and needs no press state.
    const anchors = html.split("<a ").filter((chunk) => chunk.includes('href="/test-shop/book"'));
    expect(anchors.length).toBe(4);
    const tags = anchors.map((chunk) => chunk.slice(0, chunk.indexOf(">")));
    const primaries = tags.filter((tag) => tag.includes("bg-[color:var(--color-accent)]"));
    expect(primaries.length).toBe(3);
    for (const tag of primaries) expect(tag).toContain("active:scale-[0.98]");
  });
});
```

Run: `cd apps/web && npx vitest run app/components/site/sections/heroVariants.test.tsx app/components/CommercialShopChrome.test.tsx`
Expected: both new tests FAIL on `active:scale-[0.98]`.

- [ ] **Step 2: Add the press state**

Append ` active:scale-[0.98]` (with `transition` where the class list lacks it) to:

- `HeroSection.tsx:73` Link className (already has `transition hover:brightness-110`): append ` active:scale-[0.98]`.
- `HeroSplitSection.tsx:52`, `HeroEditorialSection.tsx:42`, `HeroMinimalSection.tsx:36`: same append on the `/book` Link (each already contains `transition`; if one does not, add `transition` too).
- `FinalCtaSection.tsx` Link: append ` active:scale-[0.98]` after `hover:brightness-110`.
- Chrome desktop "Book Now →" and "View services →" (both `inline-flex min-h-12 ... text-[color:var(--st-on-accent)]`): append ` transition active:scale-[0.98]`.
- Chrome mobile header "Book": append ` transition active:scale-[0.98]`.
- Chrome menu "Book Now →" and "View services →": append ` transition active:scale-[0.98]`.

- [ ] **Step 3: Contain overscroll on the chat body**

In the chrome, change the chat body
```tsx
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-3"
```
to
```tsx
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-3"
```
(The mobile menu received `overscroll-contain` in Task 7; the panel itself has `overscroll-behavior: contain` in `.pp-chat-panel`.)

- [ ] **Step 4: Hover-only affordance check (no code expected)**

Grep `apps/web/app/components/CommercialShopChrome.tsx` and `apps/web/app/components/site/sections/*.tsx` for `hover:` and confirm each hover style is an enhancement on a control that is already visibly a control without hover (filled button, underlined link, bordered icon). The desktop-only "Scroll down ↓" in `HeroSection.tsx` is `hidden md:block`, so phones never see a hover-only control. Record the outcome in the task report; change nothing unless a control's ONLY affordance is hover, in which case add a visible resting style using `--st-*` tokens.

- [ ] **Step 5: Run everything, commit**

Run: `cd apps/web && npm test && npx tsc && npm run lint`
Expected: suite green including `renderParity`, `seededSweep`, `imageAwareVariants`.

```bash
git add apps/web/app/components/CommercialShopChrome.tsx apps/web/app/components/CommercialShopChrome.test.tsx apps/web/app/components/site/sections/HeroSection.tsx apps/web/app/components/site/sections/HeroSplitSection.tsx apps/web/app/components/site/sections/HeroEditorialSection.tsx apps/web/app/components/site/sections/HeroMinimalSection.tsx apps/web/app/components/site/sections/FinalCtaSection.tsx apps/web/app/components/site/sections/heroVariants.test.tsx
git commit -m "feat(site): press feedback on primary booking CTAs and contained overscroll on chat and menu" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB'
```

---

### Task 9: Whole-branch verification and pull request

**Files:** none new.

- [ ] **Step 1: Full gates from the repo root**

Run, saving output to a file and reading the exit code directly (a pipe into `tail` would hide a failure):

```bash
cd "F:/Projects/Pivot Parlor/pivot-parlor"
LOG=$(mktemp -d)
npm run check-types > "$LOG/types.log" 2>&1; echo "types rc=$?"
(cd apps/web && npm test > "$LOG/web-test.log" 2>&1; echo "web tests rc=$?")
(cd apps/web && npm run lint > "$LOG/lint.log" 2>&1; echo "lint rc=$?")
(cd apps/web && npm run build > "$LOG/build.log" 2>&1; echo "build rc=$?")
echo "logs in $LOG"
```
Expected: every `rc=0`. Read the web-test log tail and confirm the count includes the new files (`useScrolledPastHero`, `MobileBookingBar`, `CommercialShopChrome`, `installPrompt`, `InstallAppPrompt`, `InstallAppButton`: 5 + 4 + 6 + 8 + 4 + 4 = 31 new tests) and that `renderParity`, `seededSweep`, `imageAwareVariants` ran and passed.

- [ ] **Step 2: Scheme-honesty acceptance check (spec Section B, no code)**

Confirm in `CommercialShopChrome.tsx` that `rootStyle` still sets `colorScheme: theme.scheme` and that nothing added in this branch reads `prefers-color-scheme` or flips brand colours. Grep the branch diff for `prefers-color-scheme`: expected no matches. Record the result.

- [ ] **Step 3: Route twins**

Run: `ls apps/web/app/routes/*.js 2>/dev/null | wc -l`
Expected: `0`. If not, delete the twins next to routes edited in this branch.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/mobile-native-feel
gh pr create --title "feat(site): app-like mobile feel: sticky booking bar, safe areas, press feedback, install surfaces" --label e2e --body-file - <<'EOF'
Third and final PR of the Site Design v3 program (spec section B).

- Sticky phone-only "Book now" bar appears once the hero scrolls away, hidden on /book, /confirm and /waitlist; never in SSR markup; no-JS visitors keep the header button.
- Safe-area padding on the sticky header, mobile menu, chat panel and launcher, cookie notice, and the new bar. The chat launcher rises above the bar on phones.
- Press-state feedback on every primary booking CTA; overscroll contained on the menu and chat.
- Install surfaces: "Install this shop's app" row in the mobile menu and an "Add {shop} to your home screen" chip on the booking confirmation, both reusing the existing install logic through a shared store (one captured beforeinstallprompt, one iOS walkthrough).

Web-only. No worker, migration, or background-worker change. 31 new vitest tests; renderParity / seededSweep / imageAwareVariants unchanged and green.

Planning decisions worth a glance: waitlist also suppresses the bar; the cookie notice sits above the bar until acknowledged; the on-demand install guide ignores an earlier "Not now".

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB
EOF
```

- [ ] **Step 5: Watch CI**

Run: `gh pr checks --watch`
Expected: type/lint/test and the label-gated staging E2E workflow both green. On a Cloudflare 522/523 flake in a deploy step, `gh run rerun <id> --failed` once before investigating.

- [ ] **Step 6: Hand back**

Report: gates, PR URL, and the post-merge checklist below. The owner merges (standing rule: Claude does not self-merge production deploys).

## Post-merge verification checklist (owner + Claude, on production)

After the Pages deploy for `main` succeeds, on `https://pivotparlor.com/ferdyms-barber-shop-014` (a test shop; safe to browse):

1. Chrome DevTools device emulation at 390 by 844: no bar on load; scroll past the hero: bar slides in with "Book now →"; scroll back to the top: bar slides out. Chat launcher sits above the bar while it shows.
2. Tap "Book now →": lands on `/book`; no bar there. Back to the landing page.
3. Open the hamburger menu: on Android Chrome (real device, installability criteria met) the "Install this shop's app" row appears; on desktop emulation it does not (expected).
4. Complete a free booking (or use an existing confirmation URL): the confirmation page shows no bar; on a real Android phone or iPhone it shows the "Add FerdyM's ... to your home screen" chip; tapping it opens the native dialog (Android) or the Share -> Add to Home Screen steps (iPhone).
5. iPhone Safari, landscape: header and bar content stay clear of the notch and home indicator.
6. Desktop at 1280 wide: nothing changed except press feedback on buttons.
7. Keyboard: with the bar hidden, Tab never lands on it; with it visible, Tab reaches "Book now →".

Then update memory (`site-design-v3-program.md`: PR 3 shipped) and close the Site Design v3 program.

## Self-review

**Spec coverage (Section B):**
- Sticky mobile booking bar after the hero, safe-area aware, "Book now" / "View services", hidden on desktop, suppressed on /book and /confirm: Tasks 1, 2, 3.
- Safe areas on header, mobile menu, chat panel, bottom bar: Tasks 2, 7 (plus launcher and cookie notice).
- Scheme honesty: already implemented (#66); acceptance check in Task 9 Step 2.
- Micro-feel: press-state on primary CTAs (Task 8, and the bar/chip/launcher carry it from Tasks 2, 6, 7), overscroll containment (Tasks 7, 8), no hover-only affordances (Task 8 Step 4), 44px targets (`min-h-12` on every new control).
- Install discoverability: menu row and confirmation chip reusing the existing logic (Tasks 4, 5, 6); manifest, modal and no-SW stance untouched.
- Testing section of the spec: reveal-style jsdom tests for the observer hook (Task 1); staging E2E gate via the `e2e` label (Task 9).

**Placeholder scan:** no TBD/TODO; every code step shows the code; every test step shows the test.

**Type consistency:** `useScrolledPastHero(enabled)` returns `{ sentinelRef, pastHero }` (Tasks 1, 3). `MobileBookingBar` props `{ shopSlug, bookingEnabled, visible }` (Tasks 2, 3). Store exports `getInstallMode`, `isInstallGuideOpen`, `subscribeInstall`, `promptInstall`, `requestInstall`, `openInstallGuide`, `closeInstallGuide`, `useInstallMode`, `useInstallGuideOpen` (Tasks 4, 5, 6). `InstallAppButton` props `{ shopName, look, onActivate?, className? }` (Task 6). Chrome prop `bookingBar` (Tasks 3, routes). CSS class names match between Task 2's stylesheet and Tasks 3, 6, 7 markup; the safe-area rules read a `--pp-pad-*` floor (Task 2) and the cookie notice is the only element that sets one (Task 7).
