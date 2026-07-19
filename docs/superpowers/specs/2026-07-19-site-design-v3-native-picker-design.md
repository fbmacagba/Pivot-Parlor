# Site Design v3, App-Like Native Feel, and Cascaded Model Picker — Design

Date: 2026-07-19
Status: Approved in brainstorming (all sections), pending implementation plan.
Owner decisions captured via AskUserQuestion in the design session.

## Problem

Generated shop sites share one template's bones: 6 layout-mood archetypes reorder
the same 7 sections of a single 585-line `CommercialTemplate`, with palette,
fonts, images, and small FNV-1a-seeded tokens as the only differentiators. The
result reads as structurally samey ("AI slop"), has zero motion, and mobile
visitors get a shrunk desktop page rather than something app-like. Separately,
the AI Deploy model picker is a flat list of 10 providers with one flagship
each, duplicated between web constants and the worker model registry.

## Goals

1. Sites that are genuinely distinct from each other and reflect each shop's
   character, without ever dropping below a hand-crafted quality floor.
2. Engaging frontends: a motion system plus signature interactive moments.
3. App-like feel on mobile with an easy, discoverable install path.
4. Model selection reorganised as Provider -> Model -> Effort cascaded
   dropdowns over the top 5 providers, from a single shared catalog.

## Non-goals

- No AI-generated markup/CSS/code (rejected: slop and safety risk).
- No iOS/Android platform-mimicking UI (rejected: uncanny, double surface).
- No service worker (standing decision: payments app, stale-cache risk).
- No changes to existing sites until an owner regenerates (v3 is gated).

## Decisions (user-confirmed)

- Uniqueness: **AI design director by default, deterministic composer as a
  developer-selectable alternative** (per-generation switch, default `ai`).
- Native feel: **app-like web** (one design language; no platform skins).
- Providers: **Google, Anthropic, OpenAI, xAI, DeepSeek**.
- Engagement: **motion system + 2-3 signature sections**. (Self-review note:
  the before/after slider floated during brainstorming was dropped — every
  shop image is AI-generated ambiance, so no shop has real before/after photo
  pairs. Replaced by "spotlight" (featured service with parallax imagery and
  count-up stats from existing assets). Before/after can return if owner
  photo uploads ever ship.)

---

## Section A — Design architecture v3 ("Design Director")

### Design spec

A JSON **design spec** decides composition. Stored on `shop_sites` as
`design_spec` (TEXT column holding JSON, **migration 044**), gated by
`design_version = 3`.

```jsonc
{
  "composer": "ai" | "seed",        // who filled the spec
  "hero":     { "variant": "full-bleed" | "split" | "editorial" | "minimal",
                "motion": "parallax" | "fade" | "none" },
  "sections": [                      // ordered; hero first + CTA last implied
    { "key": "trust" | "services" | "about" | "team" | "how" | "reviews" | "location",
      "variant": "<per-section variant id>",
      "include": true }
  ],
  "motion":   { "intensity": "calm" | "lively" | "off",
                "reveal": "fade-up" | "scale" | "slide" },
  "motif":    "line" | "dot-grid" | "arc" | "none",
  "signature": "gallery" | "marquee-reviews" | "spotlight" | null,
  "density":  "airy" | "compact"
}
```

The spec **cannot express colors, fonts, or free text** — palette stays in the
existing `resolveSiteTheme` pipeline (WCAG token guard untouched), fonts stay
on the curated self-hosted set, and copy stays in the text stage.

### Composers

- **`ai` (default):** the research worker's existing single OpenRouter call is
  extended to also return `design_spec`, with the schema and the allowed enums
  embedded in the prompt, chosen to express the shop's name, services, and
  owner style notes. The worker validates the spec field-by-field (hand-rolled
  validators, matching existing code style). Any invalid or missing field
  falls back per-field to the seed composer's value; a wholly invalid spec
  falls back entirely. Generation can never fail on a bad spec.
- **`seed`:** deterministic composition from `fnv1a(shop_id)` across the same
  enums. Same code path fills defaults, powers the developer switch, and
  keeps output stable for a given shop.
- **Developer switch:** a `composer` option (`ai` | `seed`, default `ai`) on
  the generation request, surfaced in the dev generate UI next to the model
  pickers, flowing through the existing queue message (like `text_model`).
- **Owner template picker (WS-6) survives:** a chosen template constrains the
  variant families the AI may pick (as it pins `layout_mood` today). The
  template -> allowed-variants mapping lives beside the spec schema.
- **Micro-variation:** the seed continues to perturb radius, line alphas,
  stagger timing, and motif rotation *within* whatever the AI chose, so two
  shops with identical AI picks still differ.
- **Collision nudge (cheap, best-effort):** at assemble time, fingerprint =
  hash(hero.variant + ordered section variants). If another shop in D1 has the
  same fingerprint, rotate one seeded axis (motif, then density) and record
  the nudge in the job log. Single indexed query; skipped on error.

### Variant library (rendering)

`CommercialTemplate` is decomposed into per-section variant components:

```
apps/web/app/components/site/
  composer.tsx            // spec -> section components (thin)
  sections/
    hero/       FullBleed.tsx Split.tsx Editorial.tsx Minimal.tsx
    services/   Grid.tsx Rows.tsx Showcase.tsx
    about/      Standard.tsx SplitImage.tsx Story.tsx
    team/       Cards.tsx Strip.tsx
    trust/      Icons.tsx Chips.tsx
    how/        Grid.tsx Row.tsx
    reviews/    Cards.tsx Marquee.tsx Spotlight.tsx
    location/   Standard.tsx MapFirst.tsx
    signature/  Gallery.tsx Spotlight.tsx          // marquee-reviews reuses reviews/Marquee
  motion/
    useReveal.ts          // IntersectionObserver -> class toggle
    motion.css            // reveal/stagger/parallax keyframes, reduced-motion kill
```

Rules for every variant component:

- Consumes only `--st-*` theme tokens (never raw colors).
- Touch targets >= 44px; text tokens respect the /60 AA floor on dark surfaces.
- Works with `motion.intensity: off` (renders static, no observer attached).
- The v1/v2 render path (`archetypeFor`) is retained verbatim; v3 is a new
  branch in the shop routes keyed on `design_version`.

### Motion system

CSS-first. `useReveal` adds an `is-revealed` class via one shared
IntersectionObserver; keyframes and stagger delays live in `motion.css`.
`prefers-reduced-motion: reduce` disables everything at the stylesheet level;
`motion.intensity` scales distance/duration (`calm`) or enables stagger and
parallax layers (`lively`). No animation library dependency.

### Data flow (unchanged shape)

research (spec incl. design_spec) -> KV -> text + images (unchanged) ->
assembler writes `shop_sites` incl. `design_spec` + `design_version = 3` ->
web routes render via composer. The assembler's existing self-requeue and
retry behavior is untouched.

---

## Section B — App-like native feel + install

- **Sticky mobile booking bar** on shop sites: appears after scrolling past
  the hero (same IntersectionObserver infrastructure), safe-area aware,
  primary CTA `Book now` (or `View services` when booking disabled), hidden on
  desktop, suppressed on `/book` and `/confirm` (their flows own the CTA).
- **Safe areas**: `env(safe-area-inset-*)` padding on shop chrome header,
  mobile menu, chat panel, and the new bottom bar.
- **Scheme honesty**: the shop's brand palette always wins over device
  dark/light; native control chrome follows the palette's scheme via the
  existing `color-scheme` wiring (#66). No auto-flipping of brand colors.
- **Micro-feel**: press-state scale feedback on primary CTAs, overscroll
  containment on chat/menu panels, no hover-only affordances. 44px+ targets
  are an acceptance check for every new variant component.
- **Install discoverability** (keeps the branded per-shop manifest, install
  modal, and no-SW stance): add an "Install this shop's app" row to the shop
  mobile menu, and an install chip on the booking-confirmation screen
  ("Add {shop} to your home screen") — the highest-intent moment. Both reuse
  the existing `InstallAppPrompt` logic (beforeinstallprompt on Chromium,
  iOS share-sheet instructions, localStorage dismiss).

---

## Section C — Cascaded model picker

### Catalog (single source of truth)

`MODEL_CATALOG` moves to `@repo/utils`, imported by both the web UI and the
worker registry (removes today's duplicated keep-in-sync lists).

```ts
type CatalogModel = {
  id: string;            // OpenRouter id, e.g. "anthropic/claude-sonnet-5"
  label: string;
  kind: "text" | "image";
  efforts: ("low" | "medium" | "high")[] | null;  // null = no effort control
  default?: boolean;     // per kind
};
type CatalogProvider = { id: string; label: string; models: CatalogModel[] };
```

Providers: Google, Anthropic, OpenAI, xAI, DeepSeek — 2-3 text models each
(budget / flagship / premium tiers) and image models where the provider has
one (Google, OpenAI, xAI). Anthropic and DeepSeek simply do not appear in
image mode. Exact model ids/tiers are finalized against the live OpenRouter
catalog during implementation; defaults stay the current ones (Gemini Flash
Lite text, Gemini Flash Image).

### UI

Three chained selects — Provider -> Model -> Effort — replacing the flat
select in AI Deploy and the dev generate dialogs. Model list filters by
provider and kind; effort select renders only when `efforts` is non-null,
otherwise shows "Standard" (disabled). Live pricing continues to come from
`/api/ai/models`, merged onto the curated hierarchy (D1-terminal-wins and
job-status rules untouched).

### Server

The worker validates any submitted `text_model` / `image_model` against the
shared catalog (as the registry does today) and continues to pass
`text_effort` through the queues unchanged. Unknown models are rejected with
the existing error shape.

---

## Testing

- **Composer determinism**: same shop id -> identical seed spec (vitest).
- **Spec validation**: worker tests reject each malformed field and confirm
  per-field fallback; wholly invalid spec falls back to seed (worker suite).
- **Migration 044**: covered by the existing full-chain replay tests; DDL
  mirrored in `schema.sql`.
- **Reveal hook**: jsdom test that the observer toggles the class and that
  reduced-motion/`off` renders static.
- **Catalog shape**: test that every referenced default exists, ids are
  unique, and image mode never lists Anthropic/DeepSeek.
- **E2E**: staging smoke (free booking flow) must stay green; v3 sites are
  new-generation-only so fixtures are unaffected.

## Rollout

1. **PR 1 — Section C** (catalog + cascaded UI; independent quick win).
2. **PR 2 — Section A** (migration 044, research prompt + validators, variant
   library + composer, motion system; workers + web).
3. **PR 3 — Section B** (bottom bar, safe areas, install surfaces).

Background workers (research) deploy to prod by hand (standing constraint).
All lanes autonomous (no auth/payment/legal changes); PRs merge only after CI
green, by the user.

## Risks

- **Prompt bloat in the research call**: the design-spec addition grows the
  single JSON response; mitigated by enum-only fields and the per-field
  fallback (a truncated spec degrades to seed, never fails).
- **Variant library scope creep**: the 23 listed variant components are the
  ceiling for PR 2; new variants are additive follow-ups.
- **Bundle size**: no new dependencies; motion is CSS + one hook. Signature
  sections use only existing assets (gallery/spotlight compose the shop's
  catalog and hero images already in R2 — no new image-generation stages).
