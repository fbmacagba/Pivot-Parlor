# Cascaded Model Picker Implementation Plan (Spec PR 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 10-provider model list with a Provider -> Model -> Effort cascaded picker over the top 5 providers, driven by one shared catalog in `@repo/utils`.

**Architecture:** A `MODEL_CATALOG` hierarchy (5 providers, 13 text + 5 image models, real OpenRouter ids pinned against the live catalogue 2026-07-19) moves into `@repo/utils` as the single source of truth. The worker's `model-registry.ts` derives its curated list from it (live-pricing merge, KV cache, and validation unchanged in shape); the web gets a reusable `ModelPicker` cascade component used by the dev.shops regen dialog and both selects on dev.ai-deploy. The worker starts validating explicitly-submitted model ids (400 on unknown) while silently falling stored legacy ids back to defaults.

**Tech Stack:** TypeScript, Turborepo workspace packages, Hono worker (vitest-pool-workers), Remix web (vitest + jsdom).

## Global Constraints

- Branch off `main`: `feat/cascaded-model-picker`. Never commit to main; merge is the user's action after CI green (`gh pr checks --watch`), never `--auto`.
- Defaults must not change: text `google/gemini-3.1-flash-lite-preview`, image `google/gemini-3.1-flash-image-preview`, theme `anthropic/claude-sonnet-5`.
- Worker responses use `{ success: boolean, data?, error? }`.
- No em-dashes in user-facing text. Dim text on dark surfaces uses `/60` tokens minimum.
- Remix gotcha: after editing any `.tsx` route, confirm no stale `.js` twin exists beside it.
- Verification bar per task: named tests green; final task runs full `npm test`, `npx tsc` (both apps), `npm run build` + `npm run lint` (web).
- Spec deviations already validated against the live OpenRouter catalogue (2026-07-19): xAI has NO image model, so image mode lists Google + OpenAI only; the old FLUX (black-forest-labs) image options, including the free `flux-schnell`, are dropped because BFL is not a top-5 provider. Surface both facts in the PR body.

---

### Task 1: Shared model catalog in `@repo/utils`

**Files:**
- Create: `packages/utils/src/modelCatalog.ts`
- Modify: `packages/utils/src/index.ts` (add re-export)
- Test: `apps/worker/test/model-catalog.test.ts` (utils has no test runner; the worker suite imports `@repo/utils`)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2-6):
  - `type TextEffort = "low" | "medium" | "high"`
  - `type ModelKind = "text" | "image"`
  - `interface CatalogModel { id: string; name: string; kind: ModelKind; description: string; fallbackInput: number; fallbackOutput: number; supportsEffort: boolean; recommended?: boolean; isDefault?: boolean }`
  - `interface CatalogProvider { id: string; label: string; models: CatalogModel[] }`
  - `interface CatalogModelWithProvider extends CatalogModel { provider: string; providerLabel: string }`
  - `const MODEL_CATALOG: CatalogProvider[]`
  - `function catalogModels(kind?: ModelKind): CatalogModelWithProvider[]`
  - `function findCatalogModel(id: string, kind?: ModelKind): CatalogModelWithProvider | undefined`
  - `const DEFAULT_TEXT_MODEL_ID = "google/gemini-3.1-flash-lite-preview"`
  - `const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3.1-flash-image-preview"`

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/model-catalog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  MODEL_CATALOG,
  catalogModels,
  findCatalogModel,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
} from "@repo/utils";

describe("MODEL_CATALOG shape", () => {
  it("carries exactly the top 5 providers in order", () => {
    expect(MODEL_CATALOG.map((p) => p.id)).toEqual([
      "google",
      "anthropic",
      "openai",
      "x-ai",
      "deepseek",
    ]);
  });

  it("has globally unique model ids", () => {
    const ids = catalogModels().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prefixes every model id with its provider id", () => {
    for (const m of catalogModels()) {
      expect(m.id.startsWith(`${m.provider}/`)).toBe(true);
    }
  });

  it("has exactly one default per kind, matching the exported constants", () => {
    const textDefaults = catalogModels("text").filter((m) => m.isDefault);
    const imageDefaults = catalogModels("image").filter((m) => m.isDefault);
    expect(textDefaults.map((m) => m.id)).toEqual([DEFAULT_TEXT_MODEL_ID]);
    expect(imageDefaults.map((m) => m.id)).toEqual([DEFAULT_IMAGE_MODEL_ID]);
  });

  it("keeps the pipeline defaults unchanged", () => {
    expect(DEFAULT_TEXT_MODEL_ID).toBe("google/gemini-3.1-flash-lite-preview");
    expect(DEFAULT_IMAGE_MODEL_ID).toBe("google/gemini-3.1-flash-image-preview");
  });

  it("offers image models only from providers that have one (google, openai)", () => {
    const providers = new Set(catalogModels("image").map((m) => m.provider));
    expect([...providers].sort()).toEqual(["google", "openai"]);
  });

  it("gives every provider 2-3 text models", () => {
    for (const p of MODEL_CATALOG) {
      const texts = p.models.filter((m) => m.kind === "text");
      expect(texts.length).toBeGreaterThanOrEqual(2);
      expect(texts.length).toBeLessThanOrEqual(3);
    }
  });

  it("marks image models as not supporting effort", () => {
    for (const m of catalogModels("image")) {
      expect(m.supportsEffort).toBe(false);
    }
  });

  it("keeps Claude Sonnet 5 as the recommended text model", () => {
    const rec = catalogModels("text").filter((m) => m.recommended);
    expect(rec.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("findCatalogModel resolves ids and enforces kind", () => {
    expect(findCatalogModel("anthropic/claude-sonnet-5")?.providerLabel).toBe("Anthropic");
    expect(findCatalogModel("anthropic/claude-sonnet-5", "image")).toBeUndefined();
    expect(findCatalogModel("black-forest-labs/flux-schnell")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/worker && npx vitest run test/model-catalog.test.ts`
Expected: FAIL — `@repo/utils` has no export named `MODEL_CATALOG`.

- [ ] **Step 3: Write the catalog module**

Create `packages/utils/src/modelCatalog.ts`:

```ts
/**
 * Cascaded OpenRouter model catalogue — single source of truth for WHICH
 * models the AI tools offer (top 5 providers, 2-3 tiers each), consumed by
 * the worker registry (validation + live-priced /api/ai/models) and the web
 * pickers. Kept deliberately small so a developer can pick at a glance and
 * so the endpoints cannot be used as a proxy to arbitrary expensive models.
 *
 * fallbackInput/fallbackOutput are USD per 1M tokens, snapshot 2026-07-19
 * from the public OpenRouter catalogue; live pricing overrides them at read
 * time in the worker registry. Image mode lists only providers that actually
 * have an image model on OpenRouter (Google, OpenAI; xAI has none).
 */

export type TextEffort = "low" | "medium" | "high";
export type ModelKind = "text" | "image";

export interface CatalogModel {
  id: string;
  name: string;
  kind: ModelKind;
  description: string;
  fallbackInput: number;
  fallbackOutput: number;
  /** Supports the OpenRouter `reasoning` param (drives the effort select). */
  supportsEffort: boolean;
  recommended?: boolean;
  /** Exactly one model per kind carries this; enforced by tests. */
  isDefault?: boolean;
}

export interface CatalogProvider {
  id: string;
  label: string;
  models: CatalogModel[];
}

export const MODEL_CATALOG: CatalogProvider[] = [
  {
    id: "google",
    label: "Google",
    models: [
      {
        id: "google/gemini-3.1-flash-lite-preview",
        name: "Gemini 3.1 Flash Lite",
        kind: "text",
        description: "Pipeline default. Fast and very cheap; solid site copy.",
        fallbackInput: 0.25,
        fallbackOutput: 1.5,
        supportsEffort: true,
        isDefault: true,
      },
      {
        id: "google/gemini-3.5-flash",
        name: "Gemini 3.5 Flash",
        kind: "text",
        description: "Latest Flash tier; sharper copy than Lite.",
        fallbackInput: 1.5,
        fallbackOutput: 9.0,
        supportsEffort: true,
      },
      {
        id: "google/gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro",
        kind: "text",
        description: "Google's flagship; strongest layout sense.",
        fallbackInput: 2.0,
        fallbackOutput: 12.0,
        supportsEffort: true,
      },
      {
        id: "google/gemini-3.1-flash-image-preview",
        name: "Gemini 3.1 Flash Image",
        kind: "image",
        description: "Pipeline default (Nano Banana 2).",
        fallbackInput: 0.5,
        fallbackOutput: 3.0,
        supportsEffort: false,
        isDefault: true,
      },
      {
        id: "google/gemini-3.1-flash-lite-image",
        name: "Gemini 3.1 Flash Lite Image",
        kind: "image",
        description: "Cheapest image tier.",
        fallbackInput: 0.25,
        fallbackOutput: 1.5,
        supportsEffort: false,
      },
      {
        id: "google/gemini-3-pro-image",
        name: "Gemini 3 Pro Image",
        kind: "image",
        description: "Highest-fidelity Google image model.",
        fallbackInput: 2.0,
        fallbackOutput: 12.0,
        supportsEffort: false,
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    models: [
      {
        id: "anthropic/claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        kind: "text",
        description: "Fast Claude; good copy on a budget.",
        fallbackInput: 1.0,
        fallbackOutput: 5.0,
        supportsEffort: true,
      },
      {
        id: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        kind: "text",
        description: "Best copy quality for the price. Recommended for client-facing sites.",
        fallbackInput: 2.0,
        fallbackOutput: 10.0,
        supportsEffort: true,
        recommended: true,
      },
      {
        id: "anthropic/claude-opus-4.8",
        name: "Claude Opus 4.8",
        kind: "text",
        description: "Premium Claude for flagship shops.",
        fallbackInput: 5.0,
        fallbackOutput: 25.0,
        supportsEffort: true,
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: [
      {
        id: "openai/gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        kind: "text",
        description: "Budget tier of OpenAI's latest family.",
        fallbackInput: 1.0,
        fallbackOutput: 6.0,
        supportsEffort: true,
      },
      {
        id: "openai/gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        kind: "text",
        description: "Strong creative writing and layout sense.",
        fallbackInput: 2.5,
        fallbackOutput: 15.0,
        supportsEffort: true,
      },
      {
        id: "openai/gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        kind: "text",
        description: "OpenAI's premium creative tier.",
        fallbackInput: 5.0,
        fallbackOutput: 30.0,
        supportsEffort: true,
      },
      {
        id: "openai/gpt-5-image-mini",
        name: "GPT-5 Image Mini",
        kind: "image",
        description: "OpenAI budget image model.",
        fallbackInput: 2.5,
        fallbackOutput: 2.0,
        supportsEffort: false,
      },
      {
        id: "openai/gpt-5.4-image-2",
        name: "GPT-5.4 Image 2",
        kind: "image",
        description: "OpenAI's premium image model.",
        fallbackInput: 8.0,
        fallbackOutput: 15.0,
        supportsEffort: false,
      },
    ],
  },
  {
    id: "x-ai",
    label: "xAI",
    models: [
      {
        id: "x-ai/grok-4.3",
        name: "Grok 4.3",
        kind: "text",
        description: "Previous Grok; very cheap for its quality.",
        fallbackInput: 1.25,
        fallbackOutput: 2.5,
        supportsEffort: true,
      },
      {
        id: "x-ai/grok-4.5",
        name: "Grok 4.5",
        kind: "text",
        description: "Punchy, direct copy. Good price for a frontier model.",
        fallbackInput: 2.0,
        fallbackOutput: 6.0,
        supportsEffort: true,
      },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: [
      {
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        kind: "text",
        description: "Cheapest capable model in the catalogue.",
        fallbackInput: 0.098,
        fallbackOutput: 0.196,
        supportsEffort: true,
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        kind: "text",
        description: "Near-frontier quality at budget pricing.",
        fallbackInput: 0.435,
        fallbackOutput: 0.87,
        supportsEffort: true,
      },
    ],
  },
];

export interface CatalogModelWithProvider extends CatalogModel {
  provider: string;
  providerLabel: string;
}

/** Flatten the catalogue, optionally filtered by kind, preserving order. */
export function catalogModels(kind?: ModelKind): CatalogModelWithProvider[] {
  const out: CatalogModelWithProvider[] = [];
  for (const p of MODEL_CATALOG) {
    for (const m of p.models) {
      if (kind && m.kind !== kind) continue;
      out.push({ ...m, provider: p.id, providerLabel: p.label });
    }
  }
  return out;
}

/** Resolve a model id; when `kind` is given, a wrong-kind match is undefined. */
export function findCatalogModel(
  id: string,
  kind?: ModelKind,
): CatalogModelWithProvider | undefined {
  return catalogModels(kind).find((m) => m.id === id);
}

export const DEFAULT_TEXT_MODEL_ID = "google/gemini-3.1-flash-lite-preview";
export const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3.1-flash-image-preview";
```

Then add to `packages/utils/src/index.ts` (top of file, beside the existing re-exports):

```ts
export * from "./modelCatalog";
```

(If `index.ts` has no `export * from` lines, add this one at the end of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/worker && npx vitest run test/model-catalog.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/modelCatalog.ts packages/utils/src/index.ts apps/worker/test/model-catalog.test.ts
git commit -m "feat(models): shared cascaded MODEL_CATALOG in @repo/utils"
```

---

### Task 2: Worker registry derives from the catalog

**Files:**
- Modify: `apps/worker/src/services/model-registry.ts` (replace `CURATED_MODELS` literal, lines 29-153; extend `AIModel` and `getModel`)
- Modify: `packages/types/src/index.ts` (or wherever `AIModel` is declared in `@repo/types` — find with `grep -rn "AIModel" packages/types/src`): add `kind: "text" | "image"`
- Modify: `apps/worker/src/services/ai-generator.ts:224` (kind-aware validation)
- Test: `apps/worker/test/model-catalog.test.ts` (extend)

**Interfaces:**
- Consumes: `catalogModels`, `findCatalogModel`, `TextEffort` from `@repo/utils` (Task 1).
- Produces:
  - `AIModel` gains `kind: "text" | "image"` (both in the worker registry interface and `@repo/types`).
  - `getModel(modelId: string, kind?: "text" | "image"): AIModel | undefined` — kind mismatch returns undefined.
  - `mergeLiveModels(live)` now emits all 18 catalog models (text + image) with `kind`.
  - `export type { TextEffort } from "@repo/utils"` keeps existing imports of `TextEffort` from the registry working.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/model-catalog.test.ts`:

```ts
import { mergeLiveModels, fallbackModels, getModel } from "../src/services/model-registry";

describe("model-registry derives from the shared catalog", () => {
  it("serves all catalog models (text + image) with kind", () => {
    const all = fallbackModels();
    expect(all.length).toBe(catalogModels().length);
    expect(all.find((m) => m.id === "google/gemini-3.1-flash-image-preview")?.kind).toBe("image");
    expect(all.find((m) => m.id === "anthropic/claude-sonnet-5")?.kind).toBe("text");
  });

  it("drops removed legacy models", () => {
    const ids = fallbackModels().map((m) => m.id);
    expect(ids).not.toContain("meta-llama/llama-4-maverick");
    expect(ids).not.toContain("black-forest-labs/flux-schnell");
  });

  it("merges live pricing by id and marks livePricing", () => {
    const merged = mergeLiveModels([
      {
        id: "anthropic/claude-sonnet-5",
        pricing: { prompt: "0.000002", completion: "0.00001" },
        supported_parameters: ["reasoning"],
      },
    ]);
    const sonnet = merged.find((m) => m.id === "anthropic/claude-sonnet-5");
    expect(sonnet?.livePricing).toBe(true);
    expect(sonnet?.costPer1MInput).toBe(2);
    const other = merged.find((m) => m.id === "x-ai/grok-4.5");
    expect(other?.livePricing).toBe(false);
  });

  it("getModel enforces kind when asked", () => {
    expect(getModel("anthropic/claude-sonnet-5", "text")).toBeDefined();
    expect(getModel("anthropic/claude-sonnet-5", "image")).toBeUndefined();
    expect(getModel("google/gemini-3.1-flash-image-preview", "image")).toBeDefined();
  });
});
```

Add `catalogModels` to the existing `@repo/utils` import at the top of the file.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd apps/worker && npx vitest run test/model-catalog.test.ts`
Expected: FAIL — `fallbackModels()` still returns the old 10 flagship entries with no `kind`.

- [ ] **Step 3: Rewrite the registry derivation**

In `apps/worker/src/services/model-registry.ts`:

1. Replace the local `TextEffort` declaration (line 14) and add catalog imports:

```ts
import {
  catalogModels,
  findCatalogModel,
  type ModelKind,
  type TextEffort,
} from "@repo/utils";

export type { TextEffort };
```

2. Add `kind: ModelKind;` to the `AIModel` interface.

3. Delete the `CuratedEntry` interface and the entire `CURATED_MODELS` literal (lines 29-153). `DEFAULT_THEME_MODEL` stays `"anthropic/claude-sonnet-5"`.

4. Rewrite `mergeLiveModels` to map over the shared catalog:

```ts
/** Join the shared catalog with the live OpenRouter catalogue (pure; unit-tested). */
export function mergeLiveModels(live: OpenRouterCatalogueModel[]): AIModel[] {
  const byId = new Map(live.map((m) => [m.id, m]));
  return catalogModels().map((c) => {
    const lm = byId.get(c.id);
    const promptUsd = lm?.pricing?.prompt != null ? Number(lm.pricing.prompt) : NaN;
    const completionUsd = lm?.pricing?.completion != null ? Number(lm.pricing.completion) : NaN;
    const hasLive = Number.isFinite(promptUsd) && Number.isFinite(completionUsd);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      provider: c.provider,
      providerLabel: c.providerLabel,
      description: c.description,
      costPer1MInput: hasLive ? round3(promptUsd * 1e6) : c.fallbackInput,
      costPer1MOutput: hasLive ? round3(completionUsd * 1e6) : c.fallbackOutput,
      supportsEffort: lm?.supported_parameters
        ? lm.supported_parameters.includes("reasoning")
        : c.supportsEffort,
      recommended: c.recommended === true,
      livePricing: hasLive,
    };
  });
}
```

5. Make `getModel` kind-aware and bump the KV cache key (cached entries lack `kind`):

```ts
const MODELS_KV_KEY = "ai:models:openrouter:v2";

/** Look up a curated model (fallback values) — used for validation, not display. */
export function getModel(modelId: string, kind?: ModelKind): AIModel | undefined {
  if (kind && !findCatalogModel(modelId, kind)) return undefined;
  return fallbackModels().find((m) => m.id === modelId);
}
```

6. In `apps/worker/src/services/ai-generator.ts` line 224 change `getModel(modelId)` to `getModel(modelId, "text")`.

7. In `@repo/types`, add `kind: "text" | "image";` to the `AIModel` interface.

- [ ] **Step 4: Run tests to verify they pass, and the full worker suite**

Run: `cd apps/worker && npx vitest run test/model-catalog.test.ts` — Expected: PASS.
Run: `cd apps/worker && npm test` — Expected: all green (an existing theme-endpoint test may reference a removed model id like `meta-llama/llama-4-maverick`; if so, update that test to use `x-ai/grok-4.5`).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/services/model-registry.ts apps/worker/src/services/ai-generator.ts packages/types apps/worker/test/model-catalog.test.ts
git commit -m "feat(models): worker registry derives from shared catalog, kind-aware validation"
```

---

### Task 3: Pipeline model validation in shops.ts

**Files:**
- Modify: `apps/worker/src/routes/shops.ts` — the settings-save handler (`text_model`/`image_model` fields around lines 690-701) and the generation-start resolution (around lines 1112-1123)
- Test: `apps/worker/test/model-validation.test.ts` (new)

**Interfaces:**
- Consumes: `findCatalogModel`, `DEFAULT_TEXT_MODEL_ID`, `DEFAULT_IMAGE_MODEL_ID` from `@repo/utils`.
- Produces: behavior only — explicit unknown/wrong-kind model in a request body returns `400 { success: false, error: "Unknown text model: <id>" }` (or `"Unknown image model: <id>"`); unknown model ids already stored in KV silently resolve to the defaults so legacy shops keep generating.

- [ ] **Step 1: Write the failing tests**

Create `apps/worker/test/model-validation.test.ts`, following the idioms of the neighboring tests (`seedShop`, `authHeaders`, `dispatch` from `test/helpers.ts` / `test/request.ts` — copy the exact setup lines from an existing `shops`-route test such as the one that exercises the settings endpoint):

```ts
import { describe, it, expect } from "vitest";
import { dispatch } from "./request";
import { seedShop, authHeaders } from "./helpers";

describe("model id validation", () => {
  it("rejects an unknown text model on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch(`/api/shops/${shopId}/settings`, {
      method: "POST",
      headers: { ...devHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ text_model: "meta-llama/llama-4-maverick" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain("Unknown text model");
  });

  it("rejects a text model submitted as image model (wrong kind)", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch(`/api/shops/${shopId}/settings`, {
      method: "POST",
      headers: { ...devHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ image_model: "anthropic/claude-sonnet-5" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a valid catalog model", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch(`/api/shops/${shopId}/settings`, {
      method: "POST",
      headers: { ...devHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        text_model: "deepseek/deepseek-v4-pro",
        image_model: "openai/gpt-5-image-mini",
      }),
    });
    expect(res.status).toBe(200);
  });
});
```

`seedShopWithDev()` is shorthand: reuse however the neighboring settings-endpoint test builds a shop plus developer auth headers — copy those exact lines rather than inventing new helpers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/worker && npx vitest run test/model-validation.test.ts`
Expected: the two rejection tests FAIL (endpoint currently accepts any string, returns 200).

- [ ] **Step 3: Implement validation**

In `apps/worker/src/routes/shops.ts`:

1. Import at the top:

```ts
import {
  findCatalogModel,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
} from "@repo/utils";
```

2. In the settings-save handler (where `body.text_model` / `body.image_model` are read, ~line 690-701), before persisting:

```ts
const textModelIn = typeof body.text_model === "string" ? body.text_model.trim() : "";
if (textModelIn && !findCatalogModel(textModelIn, "text")) {
  return c.json({ success: false, error: `Unknown text model: ${textModelIn}` }, 400);
}
const imageModelIn = typeof body.image_model === "string" ? body.image_model.trim() : "";
if (imageModelIn && !findCatalogModel(imageModelIn, "image")) {
  return c.json({ success: false, error: `Unknown image model: ${imageModelIn}` }, 400);
}
```

3. In the generation-start resolution (~lines 1112-1123), validate explicit body values the same way (400), and guard the KV-stored fallback so legacy ids degrade to defaults instead of flowing to the queue:

```ts
const storedText = settingsKv.text_model?.trim() ?? "";
const text_model =
  bodyText ||
  (storedText && findCatalogModel(storedText, "text") ? storedText : DEFAULT_TEXT_MODEL_ID);
```

(`bodyText` is the already-validated explicit body value; mirror the same shape for `image_model` with `DEFAULT_IMAGE_MODEL_ID`. Replace the current hardcoded default strings with the imported constants.)

- [ ] **Step 4: Run tests to verify they pass, plus the full worker suite**

Run: `cd apps/worker && npx vitest run test/model-validation.test.ts` — Expected: PASS.
Run: `cd apps/worker && npm test` — Expected: all green (if an existing generate test posts a now-removed model id, update it to a catalog id).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/shops.ts apps/worker/test/model-validation.test.ts
git commit -m "feat(models): validate submitted model ids against the shared catalog"
```

---

### Task 4: Web `ModelPicker` cascade component

**Files:**
- Create: `apps/web/app/components/dev-shops/ModelPicker.tsx`
- Create: `apps/web/app/components/dev-shops/modelPicker.helpers.ts`
- Modify: `apps/web/app/components/dev-shops/constants.ts` — delete `TEXT_MODEL_OPTIONS` and `IMAGE_MODEL_OPTIONS` (keep `EFFORT_OPTIONS`, `DEFAULT_TEXT_MODEL`, `DEFAULT_IMAGE_MODEL`, re-pointed at `@repo/utils` constants); add `staticPickerModels`
- Test: `apps/web/app/components/dev-shops/modelPicker.helpers.test.ts`

**Interfaces:**
- Consumes: `catalogModels`, `DEFAULT_TEXT_MODEL_ID`, `DEFAULT_IMAGE_MODEL_ID`, `type ModelKind` from `@repo/utils`; `EFFORT_OPTIONS` from `./constants`.
- Produces (used by Tasks 5-6):
  - `interface PickerModel { id: string; name: string; provider: string; providerLabel: string; costPer1MInput: number; costPer1MOutput: number; supportsEffort: boolean; recommended?: boolean; livePricing?: boolean }` (in `modelPicker.helpers.ts`; the worker's `AIModel` is structurally assignable to it)
  - `function groupByProvider(models: PickerModel[]): { id: string; label: string; models: PickerModel[] }[]`
  - `function modelPriceLabel(m: PickerModel): string` — `"$2/1M in · $10/1M out"`
  - `function staticPickerModels(kind: ModelKind): PickerModel[]` (in `constants.ts`)
  - `function ModelPicker(props: { label: string; models: PickerModel[]; value: string; onChange: (id: string) => void; effort?: string; onEffortChange?: (effort: string) => void; disabled?: boolean }): JSX.Element` — renders Provider select, Model select, and (only when the selected model `supportsEffort` and `onEffortChange` is provided) the Effort select; changing provider selects that provider's recommended-or-first model and resets effort to `""`; changing model resets effort to `""`.

- [ ] **Step 1: Write the failing helper tests**

Create `apps/web/app/components/dev-shops/modelPicker.helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupByProvider, modelPriceLabel, type PickerModel } from "./modelPicker.helpers";

const m = (id: string, provider: string, providerLabel: string): PickerModel => ({
  id,
  name: id,
  provider,
  providerLabel,
  costPer1MInput: 2,
  costPer1MOutput: 10,
  supportsEffort: true,
});

describe("groupByProvider", () => {
  it("groups in first-seen provider order and keeps model order", () => {
    const groups = groupByProvider([
      m("google/a", "google", "Google"),
      m("anthropic/x", "anthropic", "Anthropic"),
      m("google/b", "google", "Google"),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["google", "anthropic"]);
    expect(groups[0]!.models.map((x) => x.id)).toEqual(["google/a", "google/b"]);
    expect(groups[0]!.label).toBe("Google");
  });
});

describe("modelPriceLabel", () => {
  it("formats per-1M pricing", () => {
    expect(modelPriceLabel(m("a/b", "a", "A"))).toBe("$2/1M in · $10/1M out");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run app/components/dev-shops/modelPicker.helpers.test.ts`
Expected: FAIL — module `./modelPicker.helpers` does not exist.

- [ ] **Step 3: Implement helpers, component, and constants rewiring**

Create `apps/web/app/components/dev-shops/modelPicker.helpers.ts`:

```ts
// Pure logic for the cascaded model picker, split from the component so the
// grouping/labelling behaviour is unit-testable without rendering.

export interface PickerModel {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  supportsEffort: boolean;
  recommended?: boolean;
  livePricing?: boolean;
}

export interface PickerGroup {
  id: string;
  label: string;
  models: PickerModel[];
}

/** Group models by provider, preserving first-seen provider and model order. */
export function groupByProvider(models: PickerModel[]): PickerGroup[] {
  const groups: PickerGroup[] = [];
  for (const model of models) {
    let group = groups.find((g) => g.id === model.provider);
    if (!group) {
      group = { id: model.provider, label: model.providerLabel, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

export function modelPriceLabel(m: PickerModel): string {
  return `$${m.costPer1MInput}/1M in · $${m.costPer1MOutput}/1M out`;
}

/** Provider change picks that provider's recommended model, else its first. */
export function defaultModelForProvider(group: PickerGroup): PickerModel | undefined {
  return group.models.find((m) => m.recommended) ?? group.models[0];
}
```

Create `apps/web/app/components/dev-shops/ModelPicker.tsx`:

```tsx
// Cascaded Provider -> Model -> Effort picker (spec: cascaded dropdowns over
// the top 5 providers). Pass a live-priced list (from /api/ai/models) when
// available, else staticPickerModels() fallback pricing.
import { EFFORT_OPTIONS } from "./constants";
import {
  defaultModelForProvider,
  groupByProvider,
  modelPriceLabel,
  type PickerModel,
} from "./modelPicker.helpers";

const SELECT_CLASS =
  "flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold";

export function ModelPicker({
  label,
  models,
  value,
  onChange,
  effort,
  onEffortChange,
  disabled = false,
}: {
  label: string;
  models: PickerModel[];
  value: string;
  onChange: (id: string) => void;
  /** Current effort ("" = model decides). Omit both effort props to hide the effort select (image models). */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  disabled?: boolean;
}) {
  const groups = groupByProvider(models);
  const selected = models.find((m) => m.id === value);
  const providerId = selected?.provider ?? groups[0]?.id ?? "";
  const providerModels = groups.find((g) => g.id === providerId)?.models ?? [];
  const effortVisible = onEffortChange !== undefined && selected?.supportsEffort === true;

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-white/80">{label} provider</label>
        <select
          value={providerId}
          onChange={(e) => {
            const group = groups.find((g) => g.id === e.target.value);
            const next = group ? defaultModelForProvider(group) : undefined;
            if (next) {
              onChange(next.id);
              onEffortChange?.("");
            }
          }}
          disabled={disabled}
          className={SELECT_CLASS}
        >
          {groups.map((g) => (
            <option key={g.id} value={g.id} className="bg-dark">
              {g.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-medium text-white/80">{label} model</label>
        <select
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onEffortChange?.("");
          }}
          disabled={disabled}
          className={SELECT_CLASS}
        >
          {providerModels.map((m) => (
            <option key={m.id} value={m.id} className="bg-dark">
              {m.name}
              {m.recommended ? " ★" : ""} — {modelPriceLabel(m)}
            </option>
          ))}
        </select>
      </div>
      {effortVisible && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-white/80">Reasoning effort</label>
          <select
            value={effort ?? ""}
            onChange={(e) => onEffortChange?.(e.target.value)}
            disabled={disabled}
            className={SELECT_CLASS}
          >
            {EFFORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="bg-dark">
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
```

In `apps/web/app/components/dev-shops/constants.ts`:

1. Delete the `TEXT_MODEL_OPTIONS` and `IMAGE_MODEL_OPTIONS` arrays.
2. Re-point the defaults and add the static list builder:

```ts
import {
  catalogModels,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  type ModelKind,
} from "@repo/utils";
import type { PickerModel } from "./modelPicker.helpers";

export const DEFAULT_TEXT_MODEL = DEFAULT_TEXT_MODEL_ID;
export const DEFAULT_IMAGE_MODEL = DEFAULT_IMAGE_MODEL_ID;

/** Catalog entries with snapshot pricing, for pickers without a live-priced loader. */
export function staticPickerModels(kind: ModelKind): PickerModel[] {
  return catalogModels(kind).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    providerLabel: m.providerLabel,
    costPer1MInput: m.fallbackInput,
    costPer1MOutput: m.fallbackOutput,
    supportsEffort: m.supportsEffort,
    recommended: m.recommended,
    livePricing: false,
  }));
}
```

(`EFFORT_OPTIONS` and everything else in the file stays.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/web && npx vitest run app/components/dev-shops/modelPicker.helpers.test.ts` — Expected: PASS.
Run: `cd apps/web && npx tsc` — Expected: errors ONLY in `dev.shops.tsx` (it still imports the deleted `TEXT_MODEL_OPTIONS`/`IMAGE_MODEL_OPTIONS`); those are fixed in Task 5. If other files error, fix them here.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/dev-shops/ModelPicker.tsx apps/web/app/components/dev-shops/modelPicker.helpers.ts apps/web/app/components/dev-shops/modelPicker.helpers.test.ts apps/web/app/components/dev-shops/constants.ts
git commit -m "feat(web): cascaded ModelPicker component + shared static catalog entries"
```

---

### Task 5: Wire dev.shops regen dialog to the cascade

**Files:**
- Modify: `apps/web/app/routes/dev.shops.tsx` — imports (~line 24) and the regen dialog selects (lines ~1382-1431)

**Interfaces:**
- Consumes: `ModelPicker` (Task 4), `staticPickerModels` (Task 4). Existing state vars stay: `regenTextModel`, `regenTextEffort`, `regenImageModel`, and the submit payload (lines 1450-1455) is unchanged.

- [ ] **Step 1: Replace imports**

In the import from `~/components/dev-shops/constants` remove `TEXT_MODEL_OPTIONS` and `IMAGE_MODEL_OPTIONS`, add `staticPickerModels`; add:

```ts
import { ModelPicker } from "~/components/dev-shops/ModelPicker";
```

- [ ] **Step 2: Replace the three selects**

Replace the entire block from `<div>` containing the "Text &amp; Research Model" label (line ~1382) through the closing `</div>` of the "Image Model" select (line ~1431) with:

```tsx
<ModelPicker
  label="Text & research"
  models={staticPickerModels("text")}
  value={regenTextModel}
  onChange={setRegenTextModel}
  effort={regenTextEffort}
  onEffortChange={setRegenTextEffort}
  disabled={settingsFetcher.state !== "idle"}
/>
<ModelPicker
  label="Image"
  models={staticPickerModels("image")}
  value={regenImageModel}
  onChange={setRegenImageModel}
  disabled={settingsFetcher.state !== "idle"}
/>
```

- [ ] **Step 3: Verify types, twins, and behavior parity**

Run: `cd apps/web && npx tsc` — Expected: clean.
Run: `ls apps/web/app/routes/dev.shops.js 2>/dev/null` — Expected: no output (no stale twin).
Check: the saved payload keys (`text_model`, `text_effort`, `image_model`) at lines ~1450-1455 are untouched.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/routes/dev.shops.tsx
git commit -m "feat(web): regen dialog uses cascaded model picker"
```

---

### Task 6: Wire dev.ai-deploy to the cascade

**Files:**
- Modify: `apps/web/app/routes/dev.ai-deploy.tsx` — the main model select (~lines 218-240) and the compare "Model B" select; keep loader, effort logic, and submit payloads unchanged

**Interfaces:**
- Consumes: `ModelPicker` (Task 4). The loader's `models: AIModel[]` (now carrying `kind` from Task 2) is structurally assignable to `PickerModel[]`.

- [ ] **Step 1: Filter to text models and wire the main picker**

Add after the loader destructure (line ~41):

```ts
const textModels = models.filter((m) => m.kind === "text");
```

Replace the flat main `<select>` block (the one rendering `models.map((m) => ... modelOptionLabel(m))`, ~lines 218-235) with:

```tsx
<ModelPicker
  label="Theme"
  models={textModels}
  value={modelId}
  onChange={(id) => {
    setModelChoice(id);
    setEffort("");
  }}
  effort={effort}
  onEffortChange={setEffort}
/>
```

and add the import:

```ts
import { ModelPicker } from "~/components/dev-shops/ModelPicker";
```

Keep the "live pricing" footnote paragraph (lines ~236-240) below the picker. The standalone effort select block (~lines 243+) is now redundant — delete it (the picker renders effort). `recommendedId` (line 44) should also derive from `textModels` instead of `models`.

- [ ] **Step 2: Wire the compare Model B select**

Replace the Model B flat select with:

```tsx
<ModelPicker
  label="Model B"
  models={textModels}
  value={modelBId}
  onChange={setModelBId}
/>
```

(Model B has no separate effort control today — the shared `effort` applies to both sides in the compare payload; keep that behavior.)

If `modelOptionLabel` (line ~103) is now unused, delete it.

- [ ] **Step 3: Verify**

Run: `cd apps/web && npx tsc` — Expected: clean.
Run: `ls apps/web/app/routes/dev.ai-deploy.js 2>/dev/null` — Expected: no output.
Check: submit payloads still send `model_id`, `model_a_id`, `model_b_id`, and `effort` exactly as before (lines ~118-165).

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/routes/dev.ai-deploy.tsx
git commit -m "feat(web): AI Deploy uses cascaded picker for model and compare selects"
```

---

### Task 7: Full verification and PR

**Files:** none new.

- [ ] **Step 1: Full test battery**

```bash
cd "F:\Projects\Pivot Parlor\pivot-parlor"
npm test                      # all workspaces green
cd apps/web && npx vitest run && npx tsc && npm run build && npm run lint
cd ../worker && npx tsc --noEmit
```

Expected: everything green, lint zero warnings.

- [ ] **Step 2: Push and open the PR (user merges)**

```bash
git push -u origin feat/cascaded-model-picker
gh pr create --title "feat(models): top-5 cascaded model picker over a shared catalog" --body "<summary per repo conventions; note the two catalog deviations: xAI has no OpenRouter image model so image mode lists Google+OpenAI only, and the non-top-5 FLUX options (incl. the free flux-schnell) are dropped; legacy stored model ids silently fall back to defaults; KV models cache key bumped v1->v2. 🤖 Generated with [Claude Code](https://claude.com/claude-code)>"
gh pr checks --watch
```

Expected: both checks green ("Type check, lint, test" + "E2E against staging"). Report to the user for merge; never self-merge.

---

## Self-review notes (already applied)

- Live-catalog verification (2026-07-19) pinned every model id; xAI image absence and FLUX removal are recorded as Global Constraints so the PR body surfaces them.
- `getModel` keeps its 1-arg signature valid, so untouched call sites still compile.
- The KV cache key bump (`v1`->`v2`) prevents day-one stale cached lists without `kind`.
- Type consistency check: `PickerModel` field names match the registry `AIModel` fields exactly (structural assignability is what Task 6 relies on).
