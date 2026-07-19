# Design Director Core Implementation Plan (Spec PR 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plumb a schema-validated per-shop `design_spec` end-to-end (AI-composed by default, deterministically seed-composed on a developer switch or on validation fallback) with ZERO visual change — the renderer keeps ignoring it until PR 2b.

**Architecture:** A shared `designSpec` module in `@repo/utils` defines the spec types, enum registry, deterministic seed composer, and per-field normalizer; the research worker (standalone, synced copy) asks the model for a `design_spec` block in its existing single JSON call (ai mode) or skips asking (seed mode), then normalizes with per-field fallback to the seed spec; the assembler stores the spec on `shop_sites.design_spec` (migration 044) with `design_version = 3`. A `composer` option ("ai" default | "seed") flows from the dev UI through the existing body + settings-KV path like `text_model`. Also fixes a confirmed pre-existing bug: research's `parseInput` drops the queue message's `template`, so the WS-6 owner-template pin has been dead code.

**Tech Stack:** TypeScript; Hono worker (vitest-pool-workers); standalone Cloudflare Workers (research/builder — typecheck-verified per repo precedent, logic tested via the shared module + a sync-guard test); Remix web.

## Global Constraints

- Branch `feat/design-director-core` off `feat/cascaded-model-picker` (stacked; PR base = `feat/cascaded-model-picker`, auto-retargets when #87 merges — merge the base WITHOUT `--delete-branch`). Never commit to main; user merges after CI green; never `--auto`.
- Migration number is **044** (`apps/worker/src/db/migrations/044_site_design_spec.sql`); shop_sites is NOT in schema.sql (created by migration 003), so schema.sql is untouched.
- `design_version` semantics: 3 = row carries a `design_spec`; assembler writes 3 only when a spec is present, else keeps writing 2. Rendering behavior MUST NOT change in this PR (web renderer never reads `design_spec` yet; `resolveSiteTheme`/`archetypeFor` gates use `>= 2` so v3 rows render identically).
- Composer values: exactly `"ai"` and `"seed"`; default `"ai"`. Explicit invalid value in a request body -> `400 { success: false, error: "Unknown composer: <v>" }`; stored/queued invalid values silently default to `"ai"`.
- The seed composer never picks `intensity: "off"` and never picks `signature: null` (those are AI/owner choices); `services` and `location` sections are always `include: true`.
- Worker responses `{ success: boolean, data?, error? }`. No em-dashes in user-facing text. No stale `.js` route twins.
- apps/workers/research and builder do NOT import `@repo/utils` (standalone lockfiles) — shared logic is a synced copy between `// SYNC-START designSpec` / `// SYNC-END designSpec` markers, guarded by a file-comparison test.
- Deploy order after merge (user runs background-worker deploys by hand): main worker first (CI applies migration 044), then builder, then research. Mixed versions are safe: old research + new builder -> no `design_spec` in KV -> writes v2/NULL; new research + old builder -> extra KV field ignored.

---

### Task 1: `designSpec` module in `@repo/utils`

**Files:**
- Create: `packages/utils/src/designSpec.ts`
- Modify: `packages/utils/src/index.ts` (add `export * from "./designSpec";` beside the existing `export * from` lines at the top)
- Test: `apps/worker/test/design-spec.test.ts` (utils has no runner; worker suite imports `@repo/utils`)

**Interfaces:**
- Consumes: `fnv1a` from `./siteTheme` (already exported by `@repo/utils`).
- Produces (used by Tasks 3-6 and PR 2b):
  - Types: `ComposerId = "ai" | "seed"`, `HeroVariant`, `HeroMotion`, `DesignSectionKey`, `MotionIntensity`, `RevealStyle`, `Motif`, `SignatureId`, `Density`, `DesignSpecSection { key; variant; include }`, `DesignSpec { composer; hero: { variant; motion }; sections: DesignSpecSection[]; motion: { intensity; reveal }; motif; signature: SignatureId | null; density }`
  - Consts: `HERO_VARIANTS`, `HERO_MOTIONS`, `DESIGN_SECTION_KEYS`, `SECTION_VARIANTS`, `SECTION_ORDERS`, `MOTION_INTENSITIES`, `REVEAL_STYLES`, `MOTIFS`, `SIGNATURES`, `DENSITIES`, `TEMPLATE_HERO_CONSTRAINTS`
  - `seedComposeDesignSpec(shopId: string, opts?: { template?: string }): DesignSpec`
  - `normalizeDesignSpec(raw: unknown, fallback: DesignSpec): { spec: DesignSpec; fellBack: string[] }`
  - `parseComposer(v: unknown): ComposerId | undefined`

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/test/design-spec.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DESIGN_SECTION_KEYS,
  SECTION_VARIANTS,
  TEMPLATE_HERO_CONSTRAINTS,
  seedComposeDesignSpec,
  normalizeDesignSpec,
  parseComposer,
  type DesignSpec,
} from "@repo/utils";

describe("seedComposeDesignSpec", () => {
  it("is deterministic for a shop id", () => {
    const a = seedComposeDesignSpec("shop-123");
    const b = seedComposeDesignSpec("shop-123");
    expect(a).toEqual(b);
  });

  it("differs across shop ids on at least one axis", () => {
    const a = seedComposeDesignSpec("shop-123");
    const b = seedComposeDesignSpec("shop-456");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("emits every section key exactly once with a valid variant", () => {
    const spec = seedComposeDesignSpec("any-shop");
    expect(spec.sections.map((s) => s.key).sort()).toEqual([...DESIGN_SECTION_KEYS].sort());
    for (const s of spec.sections) {
      expect(SECTION_VARIANTS[s.key]).toContain(s.variant);
      expect(s.include).toBe(true);
    }
  });

  it("marks itself as the seed composer and never picks off/null", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const spec = seedComposeDesignSpec(id);
      expect(spec.composer).toBe("seed");
      expect(spec.motion.intensity).not.toBe("off");
      expect(spec.signature).not.toBeNull();
    }
  });

  it("respects the owner template's hero constraint", () => {
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const spec = seedComposeDesignSpec(id, { template: "luxury" });
      expect(TEMPLATE_HERO_CONSTRAINTS.luxury).toContain(spec.hero.variant);
    }
  });
});

describe("normalizeDesignSpec", () => {
  const fallback: DesignSpec = seedComposeDesignSpec("fallback-shop");

  it("falls back entirely on garbage input", () => {
    const { spec, fellBack } = normalizeDesignSpec("not an object", fallback);
    expect(fellBack).toEqual(["all"]);
    expect(spec).toEqual(fallback);
    expect(spec.composer).toBe("seed");
  });

  it("accepts a fully valid ai spec and marks composer ai", () => {
    const raw = {
      hero: { variant: "split", motion: "fade" },
      sections: [
        { key: "trust", variant: "chips", include: true },
        { key: "services", variant: "rows", include: true },
        { key: "about", variant: "story", include: true },
        { key: "team", variant: "strip", include: false },
        { key: "how", variant: "row", include: true },
        { key: "reviews", variant: "marquee", include: true },
        { key: "location", variant: "map-first", include: true },
      ],
      motion: { intensity: "calm", reveal: "slide" },
      motif: "arc",
      signature: "gallery",
      density: "airy",
    };
    const { spec, fellBack } = normalizeDesignSpec(raw, fallback);
    expect(fellBack).toEqual([]);
    expect(spec.composer).toBe("ai");
    expect(spec.hero).toEqual({ variant: "split", motion: "fade" });
    expect(spec.sections.find((s) => s.key === "team")?.include).toBe(false);
    expect(spec.signature).toBe("gallery");
  });

  it("repairs invalid fields per-field and records them", () => {
    const raw = {
      hero: { variant: "hologram", motion: "fade" },
      sections: "nope",
      motion: { intensity: "lively", reveal: "spin" },
      motif: "line",
      signature: "before-after",
      density: "compact",
    };
    const { spec, fellBack } = normalizeDesignSpec(raw, fallback);
    expect(spec.composer).toBe("ai");
    expect(spec.hero.variant).toBe(fallback.hero.variant);
    expect(spec.hero.motion).toBe("fade");
    expect(spec.sections).toEqual(fallback.sections);
    expect(spec.motion.reveal).toBe(fallback.motion.reveal);
    expect(spec.motion.intensity).toBe("lively");
    expect(spec.signature).toBe(fallback.signature);
    expect(fellBack).toContain("hero.variant");
    expect(fellBack).toContain("sections");
    expect(fellBack).toContain("motion.reveal");
    expect(fellBack).toContain("signature");
  });

  it("forces services and location to stay included and fills missing sections", () => {
    const raw = {
      hero: { variant: "minimal", motion: "none" },
      sections: [
        { key: "services", variant: "grid", include: false },
        { key: "location", variant: "standard", include: false },
        { key: "services", variant: "rows", include: true },
      ],
      motion: { intensity: "calm", reveal: "fade-up" },
      motif: "none",
      signature: null,
      density: "compact",
    };
    const { spec, fellBack } = normalizeDesignSpec(raw, fallback);
    expect(spec.sections.map((s) => s.key).sort()).toEqual([...DESIGN_SECTION_KEYS].sort());
    expect(spec.sections.find((s) => s.key === "services")?.include).toBe(true);
    expect(spec.sections.find((s) => s.key === "location")?.include).toBe(true);
    expect(spec.signature).toBeNull();
    expect(fellBack.some((f) => f.startsWith("sections."))).toBe(true);
  });
});

describe("parseComposer", () => {
  it("accepts only ai and seed", () => {
    expect(parseComposer("ai")).toBe("ai");
    expect(parseComposer("seed")).toBe("seed");
    expect(parseComposer("AI")).toBeUndefined();
    expect(parseComposer("")).toBeUndefined();
    expect(parseComposer(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/worker && npx vitest run test/design-spec.test.ts`
Expected: FAIL — `@repo/utils` has no export `seedComposeDesignSpec`.

- [ ] **Step 3: Implement the module**

Create `packages/utils/src/designSpec.ts` (everything between the SYNC markers must stay byte-identical to the research copy created in Task 4):

```ts
/**
 * Design Director spec (Site Design v3, spec PR 2a) — the schema-validated
 * composition record stored on shop_sites.design_spec. The renderer consumes
 * it in PR 2b; this module owns the types, the deterministic seed composer,
 * and the per-field normalizer used to repair AI output.
 *
 * apps/workers/research keeps a SYNCED COPY of the block between the
 * SYNC-START/SYNC-END markers (standalone worker, no @repo imports) — see
 * apps/workers/research/src/design-spec.ts and the sync-guard test in
 * apps/web/app/lib/designSpecSync.test.ts. Change one, change both.
 */
import { fnv1a } from "./siteTheme";

// SYNC-START designSpec
export type ComposerId = "ai" | "seed";
export type HeroVariant = "full-bleed" | "split" | "editorial" | "minimal";
export type HeroMotion = "parallax" | "fade" | "none";
export type DesignSectionKey =
  | "trust"
  | "services"
  | "about"
  | "team"
  | "how"
  | "reviews"
  | "location";
export type MotionIntensity = "calm" | "lively" | "off";
export type RevealStyle = "fade-up" | "scale" | "slide";
export type Motif = "line" | "dot-grid" | "arc" | "none";
export type SignatureId = "gallery" | "marquee-reviews" | "spotlight";
export type Density = "airy" | "compact";

export interface DesignSpecSection {
  key: DesignSectionKey;
  variant: string;
  include: boolean;
}

export interface DesignSpec {
  composer: ComposerId;
  hero: { variant: HeroVariant; motion: HeroMotion };
  /** Ordered; hero renders first and the final CTA last regardless. */
  sections: DesignSpecSection[];
  motion: { intensity: MotionIntensity; reveal: RevealStyle };
  motif: Motif;
  signature: SignatureId | null;
  density: Density;
}

export const HERO_VARIANTS: readonly HeroVariant[] = ["full-bleed", "split", "editorial", "minimal"];
export const HERO_MOTIONS: readonly HeroMotion[] = ["parallax", "fade", "none"];
export const DESIGN_SECTION_KEYS: readonly DesignSectionKey[] = [
  "trust",
  "services",
  "about",
  "team",
  "how",
  "reviews",
  "location",
];
export const SECTION_VARIANTS: Record<DesignSectionKey, readonly string[]> = {
  trust: ["icons", "chips"],
  services: ["grid", "rows", "showcase"],
  about: ["standard", "split-image", "story"],
  team: ["cards", "strip"],
  how: ["grid", "row"],
  reviews: ["cards", "marquee", "spotlight"],
  location: ["standard", "map-first"],
};
/** The six WS-6 archetype orders — the seed composer picks one whole order. */
export const SECTION_ORDERS: readonly (readonly DesignSectionKey[])[] = [
  ["trust", "services", "about", "team", "how", "reviews", "location"],
  ["trust", "services", "how", "about", "team", "reviews", "location"],
  ["trust", "services", "reviews", "about", "team", "how", "location"],
  ["trust", "about", "services", "team", "reviews", "how", "location"],
  ["trust", "about", "services", "team", "how", "reviews", "location"],
  ["trust", "services", "team", "about", "how", "reviews", "location"],
];
export const MOTION_INTENSITIES: readonly MotionIntensity[] = ["calm", "lively", "off"];
export const REVEAL_STYLES: readonly RevealStyle[] = ["fade-up", "scale", "slide"];
export const MOTIFS: readonly Motif[] = ["line", "dot-grid", "arc", "none"];
export const SIGNATURES: readonly SignatureId[] = ["gallery", "marquee-reviews", "spotlight"];
export const DENSITIES: readonly Density[] = ["airy", "compact"];

/** An owner-picked template (WS-6) constrains which hero families fit its mood. */
export const TEMPLATE_HERO_CONSTRAINTS: Record<string, readonly HeroVariant[]> = {
  minimal: ["minimal", "editorial"],
  luxury: ["full-bleed", "split"],
  vibrant: ["full-bleed", "split"],
  editorial: ["editorial", "split"],
  classic: ["full-bleed", "editorial"],
  fresh: ["split", "minimal"],
};

export function parseComposer(v: unknown): ComposerId | undefined {
  return v === "ai" || v === "seed" ? v : undefined;
}

/**
 * Deterministic composer: same shop id (and template) always yields the same
 * spec. Never picks intensity "off" or a null signature — muting is an AI or
 * owner decision, and seeded sites should move.
 */
export function seedComposeDesignSpec(
  shopId: string,
  opts: { template?: string } = {},
): DesignSpec {
  const pick = <T>(axis: string, pool: readonly T[]): T =>
    pool[fnv1a(`${shopId}:design:${axis}`) % pool.length]!;
  const template = opts.template?.trim().toLowerCase() ?? "";
  const heroPool = TEMPLATE_HERO_CONSTRAINTS[template] ?? HERO_VARIANTS;
  const order = pick("order", SECTION_ORDERS);
  return {
    composer: "seed",
    hero: { variant: pick("hero", heroPool), motion: pick("hero-motion", HERO_MOTIONS) },
    sections: order.map((key) => ({
      key,
      variant: pick(`section:${key}`, SECTION_VARIANTS[key]),
      include: true,
    })),
    motion: {
      intensity: pick("intensity", ["calm", "lively"] as const),
      reveal: pick("reveal", REVEAL_STYLES),
    },
    motif: pick("motif", MOTIFS),
    signature: pick("signature", SIGNATURES),
    density: pick("density", DENSITIES),
  };
}

/**
 * Repair a model-produced design_spec field by field: every invalid or
 * missing value takes the fallback's value and is recorded in `fellBack`.
 * Wholly invalid input returns the fallback verbatim with fellBack ["all"].
 * The result's composer is "ai" unless everything fell back. services and
 * location can never be excluded (a booking site needs both).
 */
export function normalizeDesignSpec(
  raw: unknown,
  fallback: DesignSpec,
): { spec: DesignSpec; fellBack: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { spec: structuredClone(fallback) as DesignSpec, fellBack: ["all"] };
  }
  const fellBack: string[] = [];
  const o = raw as Record<string, unknown>;

  const pickValid = <T>(field: string, value: unknown, pool: readonly T[], fb: T): T => {
    if (pool.includes(value as T)) return value as T;
    fellBack.push(field);
    return fb;
  };

  const heroRaw = (o.hero && typeof o.hero === "object" ? o.hero : {}) as Record<string, unknown>;
  const hero = {
    variant: pickValid("hero.variant", heroRaw.variant, HERO_VARIANTS, fallback.hero.variant),
    motion: pickValid("hero.motion", heroRaw.motion, HERO_MOTIONS, fallback.hero.motion),
  };

  const sections: DesignSpecSection[] = [];
  const seen = new Set<DesignSectionKey>();
  if (Array.isArray(o.sections)) {
    for (const entry of o.sections) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const key = DESIGN_SECTION_KEYS.includes(e.key as DesignSectionKey)
        ? (e.key as DesignSectionKey)
        : null;
      if (!key || seen.has(key)) {
        fellBack.push(`sections.${String(e.key ?? "?")}`);
        continue;
      }
      seen.add(key);
      const pool = SECTION_VARIANTS[key];
      let variant: string;
      if (typeof e.variant === "string" && pool.includes(e.variant)) {
        variant = e.variant;
      } else {
        fellBack.push(`sections.${key}.variant`);
        variant = fallback.sections.find((s) => s.key === key)?.variant ?? pool[0]!;
      }
      const include = key === "services" || key === "location" ? true : e.include !== false;
      sections.push({ key, variant, include });
    }
  } else {
    fellBack.push("sections");
  }
  for (const fb of fallback.sections) {
    if (!seen.has(fb.key)) {
      if (Array.isArray(o.sections)) fellBack.push(`sections.${fb.key}`);
      sections.push({ ...fb });
    }
  }

  const motionRaw = (o.motion && typeof o.motion === "object" ? o.motion : {}) as Record<
    string,
    unknown
  >;
  const motion = {
    intensity: pickValid(
      "motion.intensity",
      motionRaw.intensity,
      MOTION_INTENSITIES,
      fallback.motion.intensity,
    ),
    reveal: pickValid("motion.reveal", motionRaw.reveal, REVEAL_STYLES, fallback.motion.reveal),
  };

  const motif = pickValid("motif", o.motif, MOTIFS, fallback.motif);
  let signature: SignatureId | null;
  if (o.signature === null) {
    signature = null;
  } else if (SIGNATURES.includes(o.signature as SignatureId)) {
    signature = o.signature as SignatureId;
  } else {
    fellBack.push("signature");
    signature = fallback.signature;
  }
  const density = pickValid("density", o.density, DENSITIES, fallback.density);

  return {
    spec: { composer: "ai", hero, sections, motion, motif, signature, density },
    fellBack,
  };
}
// SYNC-END designSpec
```

Add `export * from "./designSpec";` to `packages/utils/src/index.ts` beside the existing `export * from` lines at the top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/worker && npx vitest run test/design-spec.test.ts`
Expected: PASS (10 tests). Note: `structuredClone` exists in workerd; if the runner complains, replace with `JSON.parse(JSON.stringify(fallback))`.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/designSpec.ts packages/utils/src/index.ts apps/worker/test/design-spec.test.ts
git commit -m "feat(design): shared designSpec module (types, seed composer, normalizer)"
```

---

### Task 2: Migration 044 + builder DDL bridge

**Files:**
- Create: `apps/worker/src/db/migrations/044_site_design_spec.sql`
- Modify: `apps/workers/builder/src/index.ts` — `ensureShopSitesSeoColumns` (the `tryAdd` list, ~lines 233-258)

**Interfaces:**
- Produces: nullable `shop_sites.design_spec` TEXT column (JSON), canonical DDL in the migration; the builder `tryAdd` only bridges a builder deploy that lands before the migration runs (established pattern in that function).

- [ ] **Step 1: Write the migration**

Create `apps/worker/src/db/migrations/044_site_design_spec.sql`:

```sql
-- Site Design v3 (Design Director): the composition spec chosen for the site.
-- JSON DesignSpec (see @repo/utils designSpec.ts). NULL for v1/v2 sites.
ALTER TABLE shop_sites ADD COLUMN design_spec TEXT;
```

- [ ] **Step 2: Add the builder bridge**

In `apps/workers/builder/src/index.ts`, inside `ensureShopSitesSeoColumns`, after the `heading_style` tryAdd:

```ts
  // Design Director spec (Site Design v3). Canonical DDL: migration 044.
  await tryAdd("design_spec", "TEXT");
```

- [ ] **Step 3: Verify the chain replays and builder typechecks**

Run: `cd apps/worker && npm test` — Expected: all green (both worker suites replay the full migration chain; a non-replayable 044 fails here).
Run: `cd apps/workers/builder && npm run typecheck 2>/dev/null || npx tsc --noEmit` — Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/db/migrations/044_site_design_spec.sql apps/workers/builder/src/index.ts
git commit -m "feat(db): migration 044 shop_sites.design_spec + builder bridge"
```

---

### Task 3: Composer plumbing in the main worker

**Files:**
- Modify: `apps/worker/src/routes/shops.ts` — settings-save handler (where `text_model`/`image_model` are validated and persisted) and the generate-site handler (body type ~1040-1064, validation block ~1071-1080, settingsKv type ~1083-1088, resolution ~1143-1156, queuePayload ~1175-1192)
- Test: `apps/worker/test/composer.test.ts` (new)

**Interfaces:**
- Consumes: `parseComposer` from `@repo/utils` (Task 1).
- Produces: generate-site queue payload gains `composer: "ai" | "seed"` (always present, default `"ai"`); settings KV may store `composer`; explicit invalid composer -> `400 { success: false, error: "Unknown composer: <v>" }` on both handlers.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/test/composer.test.ts`, copying the seeding/auth/dispatch/queue-capture idioms from `apps/worker/test/model-validation.test.ts` (same file layout: seeded shop + developer auth + `dispatch`; the generate-site tests there already capture the queue payload via the stubbed `site_research_queue` binding — reuse that exact mechanism):

```ts
import { describe, it, expect } from "vitest";

describe("composer option", () => {
  it("rejects an unknown composer on settings save", async () => {
    // POST /api/shops/:shopId/settings with { composer: "vibes" } -> 400,
    // body.success === false, body.error contains "Unknown composer".
  });

  it("accepts and stores a valid composer on settings save", async () => {
    // POST { composer: "seed" } -> 200; a subsequent generate-site with no
    // body composer must enqueue composer "seed" (read the captured payload).
  });

  it("rejects an unknown composer on generate-site", async () => {
    // POST /api/shops/:shopId/generate-site with { composer: "vibes" } -> 400
    // and the queue capture stays empty (no job enqueued).
  });

  it("body composer wins over stored settings", async () => {
    // settings composer "seed", then generate-site with { composer: "ai" }
    // -> captured payload composer === "ai".
  });

  it("defaults to ai when nothing is set", async () => {
    // generate-site with no composer anywhere -> captured payload composer === "ai".
  });
});
```

Flesh each comment into a real test using the neighboring file's exact helpers — the assertions above are the contract; the setup lines are whatever `model-validation.test.ts` already does.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/worker && npx vitest run test/composer.test.ts`
Expected: the two 400 tests FAIL (composer currently ignored, endpoint returns 200/202); the capture tests FAIL (no `composer` field in the payload).

- [ ] **Step 3: Implement**

In `apps/worker/src/routes/shops.ts`:

1. Add `parseComposer` to the existing `@repo/utils` import.
2. Generate-site `body` type gains `composer?: string;`; the multipart branch adds `composer: form.composer?.toString(),`.
3. In the validation block (directly after the image-model 400):

```ts
  const bodyComposerRaw = typeof body.composer === "string" ? body.composer.trim() : "";
  if (bodyComposerRaw && !parseComposer(bodyComposerRaw)) {
    return c.json({ success: false, error: `Unknown composer: ${bodyComposerRaw}` }, 400);
  }
```

4. `settingsKv` type gains `composer?: string;`. In the resolution block (next to `text_model`):

```ts
    // Design Director composer: request wins over saved settings; anything
    // but ai/seed (incl. legacy junk in KV) silently defaults to "ai".
    const composer =
      parseComposer(bodyComposerRaw) ?? parseComposer(settingsKv.composer) ?? "ai";
```

5. `queuePayload` gains `composer,` (unconditional).
6. Settings-save handler: body reading gains `composer`; after the image-model 400 add:

```ts
  const composerIn = typeof body.composer === "string" ? body.composer.trim() : "";
  if (composerIn && !parseComposer(composerIn)) {
    return c.json({ success: false, error: `Unknown composer: ${composerIn}` }, 400);
  }
```

and persist `composer: composerIn || undefined` into the stored KV JSON exactly the way `text_model` is persisted there (same object, same conditional-inclusion style as the neighboring fields).

- [ ] **Step 4: Run tests to verify they pass, plus the full worker suite**

Run: `cd apps/worker && npx vitest run test/composer.test.ts` — Expected: PASS.
Run: `cd apps/worker && npm test` — Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/shops.ts apps/worker/test/composer.test.ts
git commit -m "feat(design): composer option (ai|seed) plumbed through settings + generate-site queue"
```

---

### Task 4: Research worker — synced module, prompt block, normalization, template-drop fix

**Files:**
- Create: `apps/workers/research/src/design-spec.ts` (synced copy)
- Modify: `apps/workers/research/src/index.ts` — `ResearchQueueMessage` (~19-36), `ResearchSpec` interface (wherever declared; add `design_spec?: unknown`), `GenResearchKvPayload` (~85-100), `buildUserPrompt` (~201-264), `parseInput` (~414-459), the post-validation block (~555-600)
- Test: `apps/web/app/lib/designSpecSync.test.ts` (sync guard; apps/web vitest runs in Node so `fs` works there — research itself has no test harness, per repo precedent for background workers)

**Interfaces:**
- Consumes: queue message now carries `composer` (Task 3) and `template` (sent by shops.ts since WS-6 but dropped here until now).
- Produces: `GenResearchKvPayload.design_spec: DesignSpec` (ALWAYS present after this task — ai-normalized or seed-composed), consumed by Task 5.

- [ ] **Step 1: Write the failing sync-guard test**

Create `apps/web/app/lib/designSpecSync.test.ts`:

```ts
// Guards the synced designSpec copy in the research worker (standalone
// worker, no @repo imports). If this fails, re-copy the block between the
// SYNC markers from packages/utils/src/designSpec.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function syncBlock(path: string): string {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("// SYNC-START designSpec");
  const end = text.indexOf("// SYNC-END designSpec");
  expect(start, `missing SYNC-START in ${path}`).toBeGreaterThan(-1);
  expect(end, `missing SYNC-END in ${path}`).toBeGreaterThan(start);
  return text.slice(start, end).replace(/\r\n/g, "\n");
}

describe("designSpec sync", () => {
  it("research worker copy matches @repo/utils byte for byte", () => {
    const root = resolve(__dirname, "../../../..");
    const canonical = syncBlock(resolve(root, "packages/utils/src/designSpec.ts"));
    const copy = syncBlock(resolve(root, "apps/workers/research/src/design-spec.ts"));
    expect(copy).toBe(canonical);
  });
});
```

Run: `cd apps/web && npx vitest run app/lib/designSpecSync.test.ts` — Expected: FAIL (the research copy does not exist yet).

- [ ] **Step 2: Create the synced copy**

Create `apps/workers/research/src/design-spec.ts`:

```ts
/**
 * SYNCED COPY of the designSpec core from packages/utils/src/designSpec.ts
 * (this worker is standalone and cannot import @repo/utils — same pattern as
 * the curated-fonts copy). The block between the SYNC markers must stay
 * byte-identical; apps/web/app/lib/designSpecSync.test.ts enforces it.
 */

/** FNV-1a 32-bit — local copy (utils imports it from siteTheme). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// SYNC-START designSpec
// ... (paste the block from packages/utils/src/designSpec.ts verbatim)
// SYNC-END designSpec
```

IMPORTANT: before pasting, compare the local `fnv1a` above with the canonical implementation in `packages/utils/src/siteTheme.ts` and make them behaviorally identical (copy the body from siteTheme.ts verbatim — determinism across utils and research depends on it). Then re-run the sync test: `cd apps/web && npx vitest run app/lib/designSpecSync.test.ts` — Expected: PASS.

- [ ] **Step 3: Wire the research worker**

In `apps/workers/research/src/index.ts`:

1. Import: `import { seedComposeDesignSpec, normalizeDesignSpec, parseComposer, type DesignSpec, type ComposerId } from "./design-spec";`
2. `ResearchQueueMessage` gains `composer?: ComposerId;` (keep the existing optional `template?: string`).
3. `ResearchSpec` gains `design_spec?: unknown;` (NOT validated by `validateResearchSpec` — a bad design_spec must never fail the whole research spec).
4. `GenResearchKvPayload` gains `design_spec: DesignSpec;`.
5. `parseInput`: parse both new fields into the returned object (this also FIXES the pre-existing template drop — `input.template` has been permanently undefined, making the WS-6 owner-template pin dead):

```ts
  const composer: ComposerId = parseComposer(o.composer) ?? "ai";
  const template =
    typeof o.template === "string" && o.template.trim() ? o.template.trim() : undefined;
```

and in the return object add `composer,` and `...(template ? { template } : {}),`.
6. `buildUserPrompt`: only when `msg.composer !== "seed"`, insert a `design_spec` entry into the returned JSON structure after the `social_stubs` block (inside the same object literal, before the closing brace):

```text
  "design_spec": {
    "hero": { "variant": "full-bleed"|"split"|"editorial"|"minimal" (choose the treatment that best expresses this shop's character and the layout_mood), "motion": "parallax"|"fade"|"none" },
    "sections": [ ordered array covering EXACTLY these seven keys once each: trust, services, about, team, how, reviews, location. Each entry is {"key": string, "variant": string, "include": boolean}. Allowed variants: trust: icons|chips; services: grid|rows|showcase; about: standard|split-image|story; team: cards|strip; how: grid|row; reviews: cards|marquee|spotlight; location: standard|map-first. services and location must have include true. Order and exclusions should serve this shop's story. ],
    "motion": { "intensity": "calm"|"lively"|"off", "reveal": "fade-up"|"scale"|"slide" },
    "motif": "line"|"dot-grid"|"arc"|"none" (decorative accent motif),
    "signature": "gallery"|"marquee-reviews"|"spotlight"|null (at most one showpiece section),
    "density": "airy"|"compact"
  }
```

When a template pin is active (the existing `moodLine`), extend that line with: `The design_spec hero.variant must be one of: <TEMPLATE_HERO_CONSTRAINTS[template] joined with ", ">.`
7. In `processOneMessage`, after `coerceSpecCounts`/palette/template/typography post-forcing and before the `payload` construction:

```ts
    // Design Director (v3): seed spec is both the deterministic composer and
    // the fallback for invalid AI output. Per-field repair keeps generation
    // unfailable on a bad design_spec.
    const seedSpec = seedComposeDesignSpec(shopId, { template: input.template });
    let designSpec: DesignSpec;
    if (input.composer === "seed") {
      designSpec = seedSpec;
    } else {
      const normalized = normalizeDesignSpec(spec.design_spec, seedSpec);
      designSpec = normalized.spec;
      if (normalized.fellBack.length > 0) {
        console.warn(
          `[${jobId}] [pivot-parlor-research] design_spec fields fell back to seed: ${normalized.fellBack.join(", ")}`
        );
      }
    }
```

and add `design_spec: designSpec,` to the `payload` object.

- [ ] **Step 4: Verify**

Run: `cd apps/workers/research && npx tsc --noEmit` — Expected: clean.
Run: `cd apps/web && npx vitest run app/lib/designSpecSync.test.ts` — Expected: PASS.
Run: `cd apps/worker && npx vitest run test/design-spec.test.ts` — Expected: still PASS (shared logic unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/workers/research/src/design-spec.ts apps/workers/research/src/index.ts apps/web/app/lib/designSpecSync.test.ts
git commit -m "feat(design): research worker composes design_spec (ai prompt + seed fallback); fix dropped template pin"
```

---

### Task 5: Assembler stores the spec

**Files:**
- Modify: `apps/workers/builder/src/index.ts` — the research-payload type the assembler parses (the object `designIntentFrom` consumes), the `UPDATE shop_sites` statement (~379-418) and the `INSERT INTO shop_sites` statement (~422-460)

**Interfaces:**
- Consumes: `GenResearchKvPayload.design_spec` (Task 4) — treated as opaque JSON here (already normalized upstream; no synced module needed).
- Produces: `shop_sites.design_spec` = JSON string when present; `design_version` = 3 when a spec is present, else 2 (old queued research payloads mid-deploy).

- [ ] **Step 1: Implement the passthrough**

1. Wherever the parsed research payload's type is declared in the builder, add `design_spec?: unknown;`.
2. Before the UPDATE statement, derive:

```ts
  // Design Director (v3): present on payloads from the new research worker;
  // absent -> legacy v2 write so mid-deploy jobs stay consistent.
  const rawDesignSpec = research?.design_spec;
  const design_spec_json =
    rawDesignSpec && typeof rawDesignSpec === "object" ? JSON.stringify(rawDesignSpec) : null;
  const design_version = design_spec_json ? 3 : 2;
```

(`research` = the parsed `gen:{jobId}:research` KV object already in scope for `designIntentFrom`; match the actual local variable name.)
3. UPDATE statement: replace the hardcoded `design_version = 2,` with `design_spec = ?, design_version = ?,` and add `design_spec_json, design_version` to the `.bind(...)` list at the matching position.
4. INSERT statement: add `design_spec` to the column list, change the hardcoded `2` in VALUES to `?, ?` (design_spec + design_version) keeping positional order consistent, and bind `design_spec_json, design_version`.

- [ ] **Step 2: Verify**

Run: `cd apps/workers/builder && npx tsc --noEmit` — Expected: clean.
Count check: the number of `?` placeholders in each statement equals the number of `.bind()` arguments (off-by-one here fails only at runtime — count them explicitly and state the counts in your report).

- [ ] **Step 3: Commit**

```bash
git add apps/workers/builder/src/index.ts
git commit -m "feat(design): assembler stores design_spec, design_version 3 when present"
```

---

### Task 6: Dev UI composer switch

**Files:**
- Modify: `apps/web/app/routes/dev.shops.tsx` — generate form (~927-944: template select block) and its action's `generate-site` branch (~93-106); the regen dialog state + settings submit (state vars ~176-178 area, dialog fields near the ModelPickers, submit payload ~1417-1419 area)

**Interfaces:**
- Consumes: worker accepts `composer` on generate-site body and settings-save (Task 3). Regenerate flow needs no web change beyond the dialog: it saves settings (now incl. composer) and the worker reads settings KV at generate time.

- [ ] **Step 1: Generate form select + action forward**

In the generate form, after the template `<select>` (line ~944):

```tsx
                                <select
                                  name="composer"
                                  className="rounded border border-white/20 bg-white/5 px-2 py-1 text-xs text-white"
                                  title="Site composer"
                                >
                                  <option value="ai">AI design director</option>
                                  <option value="seed">Deterministic seed</option>
                                </select>
```

In the action's `generate-site` branch, after `if (template) body.template = template;`:

```ts
    const composer = form.get("composer")?.toString();
    if (composer === "ai" || composer === "seed") body.composer = composer;
```

- [ ] **Step 2: Regen dialog select + settings payload**

Add state beside the model states: `const [regenComposer, setRegenComposer] = useState("ai");`
In the dialog, after the two `ModelPicker` blocks:

```tsx
            <div>
              <label className="mb-1.5 block text-sm font-medium text-white/80">Site composer</label>
              <select
                value={regenComposer}
                onChange={(e) => setRegenComposer(e.target.value)}
                disabled={settingsFetcher.state !== "idle"}
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                <option value="ai" className="bg-dark">AI design director (default)</option>
                <option value="seed" className="bg-dark">Deterministic seed</option>
              </select>
            </div>
```

Add `composer: regenComposer,` to the settingsFetcher.submit JSON payload (beside `text_model`).

- [ ] **Step 3: Verify**

Run: `cd apps/web && npx tsc && npx vitest run && npm run build && npm run lint` — Expected: all clean/green.
Run: `ls apps/web/app/routes/dev.shops.js 2>/dev/null` — Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/routes/dev.shops.tsx
git commit -m "feat(web): composer switch (AI director / deterministic seed) in generate + regen dialogs"
```

---

### Task 7: Full verification and PR

- [ ] **Step 1: Full battery**

```bash
cd "F:\Projects\Pivot Parlor\pivot-parlor" && npm test
cd apps/web && npx tsc && npm run build && npm run lint
cd ../worker && npx tsc --noEmit
cd ../workers/research && npx tsc --noEmit
cd ../builder && npx tsc --noEmit
```

Expected: everything green.

- [ ] **Step 2: Push and open the PR (user merges; stacked base)**

```bash
git push -u origin feat/design-director-core
gh pr create --base feat/cascaded-model-picker --title "feat(design): Design Director core — design_spec end-to-end, zero visual change" --body "<summary; note: migration 044; composer ai|seed default ai; seed composer doubles as validation fallback; fixes the dead WS-6 owner-template pin (research parseInput dropped template); renderer unchanged until PR 2b; deploy order main worker -> builder -> research. 🤖 Generated with [Claude Code](https://claude.com/claude-code)>"
gh pr checks --watch
```

Expected: green. Never merge; never `--delete-branch` on the stacked base.

---

## Self-review notes (already applied)

- Zero-visual-change invariant: no web renderer file is touched; `design_version 3` passes every existing `>= 2` gate identically.
- The template-drop fix is folded into Task 4 (same function being edited) and called out in the commit + PR body.
- Mixed-deploy safety is encoded (builder writes v2/NULL when the payload lacks a spec).
- Type-consistency check: `parseComposer`/`ComposerId` names match across utils, research copy (inside the sync block), and shops.ts usage; `DesignSpec` field names match the approved spec doc exactly.
