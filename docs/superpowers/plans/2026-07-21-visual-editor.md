# Independent Visual Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let developers and shop owners edit each site visual (logo, hero, each per-service photo) independently — upload their own image, and (developer-only) AI-regenerate or remove a single visual — without a destructive full-site regenerate, with customised visuals surviving a later regenerate.

**Architecture:** Per-service custom photos live on a new `services.image_url` column (keyed by service ID, untouched by the regenerate pipeline, so they survive for free). Hero/logo customisation is marked in a new `shop_sites.locked_images_json` flag object; the assembler preserves a locked slot on regenerate. Four shop-scoped image endpoints (upload/save/generate/remove) plus one read endpoint (`GET /visuals`) back a single shared `VisualManager` React component rendered role-aware in both the developer hub and the shop-admin dashboard.

**Tech Stack:** Remix (Cloudflare Pages) frontend, Hono (Cloudflare Workers) API, Cloudflare D1 (SQLite), R2 (image storage), KV (public-site cache), `@repo/utils` shared package, vitest-pool-workers (worker tests), vitest + jsdom (web tests), OpenRouter (image generation).

## Global Constraints

Every task's requirements implicitly include these:

- **Worker API responses** use `{ success: boolean, data?: T, error?: string }`; the existing image endpoints return `{ imageUrl }` or `{ ok: true }` — match the endpoint being extended, do not reshape.
- **Shop-scoped SQL** must include `WHERE shop_id = ?` (or validate `service.shop_id === shop.id`); use prepared statements only, never interpolate user input.
- **Auth pattern (upload/save/visuals):** `user.role === "developer" || (user.role === "admin" && user.shop_id === shop.id)`. **Regenerate/remove are developer-only:** `user.role !== "developer"` → 403. Enforce server-side, not just in the UI.
- **UUIDs** via `crypto.randomUUID()`.
- **Migrations:** next number is **045**. Add the new `services` column to both `apps/worker/src/db/migrations/045_*.sql` (as `ALTER TABLE`) **and** `apps/worker/src/db/schema.sql` (the rolling snapshot). The test harness (`apps/worker/test/apply-schema.ts`) applies schema.sql first then migrations, treating `duplicate column name` / `already exists` as benign no-ops, so both together stay replayable. `shop_sites` is a migration-only table (created in migration 003, absent from schema.sql) — its new column goes in the migration ONLY.
- **`api.*` web routes are resource routes** (post-#102 invariant): no `export default`, only `export const action`/`loader`. New `api.shops.$shopId.*` routes must follow this.
- **No em-dashes in user-facing text.** Brand: gold `#C9A84C`, dark `#0D0D0D`; headings font-heading, body font.
- **Remix `.js` twin gotcha:** none of the routes touched here have `.js` twins today (verified), but if a build produces one alongside an edited `.tsx`, remove it so the stale `.js` is not served.
- **Deploy split:** migration + main-worker endpoints + web ship via CI on push to `main`. The assembler (`apps/workers/builder`) is a **manual `wrangler deploy`** background worker and is NOT in the root workspaces/`turbo run test`; its unit test runs via `cd apps/workers/builder && npm test`. The research worker is intentionally **not** rewired in this plan (see the note under Task 2).

---

### Task 1: Migration 045 — `services.image_url` + `shop_sites.locked_images_json`

**Files:**
- Create: `apps/worker/src/db/migrations/045_visual_editor.sql`
- Modify: `apps/worker/src/db/schema.sql:37-45` (the `services` CREATE TABLE)
- Modify: `apps/worker/src/db/queries.ts:48-56` (the `DBService` interface)
- Test: `apps/worker/test/apply-schema.ts` already replays the chain; the whole worker suite is the test.

**Interfaces:**
- Produces: `services.image_url TEXT` (nullable) and `shop_sites.locked_images_json TEXT` (nullable) columns; `DBService.image_url: string | null`. Consumed by every later task.

- [ ] **Step 1: Write the migration file**

Create `apps/worker/src/db/migrations/045_visual_editor.sql`:

```sql
-- Visual Editor (2026-07): per-service custom photo + hero/logo lock flags.
-- services.image_url: a service's own image (keyed by service id); NULL falls
--   back to the AI catalog pool. Also added to schema.sql, so a fresh DB built
--   from the snapshot already has it and this ALTER is a benign duplicate.
-- shop_sites.locked_images_json: {"hero":true,"logo":true}-style flags marking a
--   custom hero/logo the assembler must preserve across a full regenerate.
--   shop_sites is migration-only (not in schema.sql), so this ALTER always runs.
ALTER TABLE services   ADD COLUMN image_url TEXT;
ALTER TABLE shop_sites ADD COLUMN locked_images_json TEXT;
```

- [ ] **Step 2: Reflect `services.image_url` in the schema snapshot**

In `apps/worker/src/db/schema.sql`, change the `services` table (currently ends `is_active INTEGER NOT NULL DEFAULT 1`) to add the column:

```sql
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  shop_id      TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  price_pence  INTEGER NOT NULL DEFAULT 0,
  category     TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  image_url    TEXT
);
```

Do NOT add `locked_images_json` to schema.sql (shop_sites is not in the snapshot).

- [ ] **Step 3: Add `image_url` to the `DBService` interface**

In `apps/worker/src/db/queries.ts`, extend the interface at line 48:

```ts
export interface DBService {
  id: string;
  shop_id: string;
  name: string;
  duration_min: number;
  price_pence: number;
  category: string | null;
  is_active: number;
  image_url: string | null;
}
```

- [ ] **Step 4: Run the worker suite to prove the chain replays**

Run: `cd apps/worker && npm test`
Expected: PASS. The replay in `apply-schema.ts` applies schema.sql (now with `image_url`), then migration 045's `ALTER TABLE services ADD COLUMN image_url` throws `duplicate column name` which is swallowed as benign; the `shop_sites` ALTER runs cleanly. No `is no longer replayable` error.

- [ ] **Step 5: Type-check the worker**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: PASS (the `DBService` change compiles; `getServicesByShop`/`getServiceById` already `SELECT *`).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/db/migrations/045_visual_editor.sql apps/worker/src/db/schema.sql apps/worker/src/db/queries.ts
git commit -m "feat(db): migration 045 — services.image_url + shop_sites.locked_images_json"
```

---

### Task 2: Shared service-image prompt helper in `@repo/utils`

**Files:**
- Create: `packages/utils/src/serviceImagePrompt.ts`
- Modify: `packages/utils/src/index.ts` (add re-export)
- Test: `apps/worker/test/service-image-prompt.test.ts` (the repo tests `@repo/utils` from the worker suite — see `curated-fonts.test.ts`, `site-theme.test.ts`)

**Interfaces:**
- Produces: `catalogSubjectFor(shopType: string): string` and `buildServiceImagePrompt(serviceName: string, shopType: string): string`, exported from `@repo/utils`. Consumed by Task 7 (`generate-image`).

> **Scope note (surface in handoff):** The approved spec said "extract this template + subject helper into `@repo/utils` so the main worker AND the research worker share one source." This task places the canonical helper in `@repo/utils` and wires the **main worker** to it (frictionless — the worker already depends on `@repo/utils`). It deliberately does **not** rewire the **research** worker: research is a standalone worker (zero dependencies, does not extend the shared tsconfig, manual-deploy) and PR #104 already adds the identical gendered logic inline there (`catalogSubjectFor` + the same template string). The pinned-string test below guarantees the `@repo/utils` version stays byte-identical to research's, so there is no drift risk for the MVP. Rewiring research to import `@repo/utils` is logged as a deferred follow-up. Because this helper is pure new code that does not import research, it has **no ordering dependency on PR #104** — any merge order is safe.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/service-image-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { catalogSubjectFor, buildServiceImagePrompt } from "@repo/utils";

// This prompt string must stay byte-identical to the research worker's catalog
// template (apps/workers/research/src/index.ts, catalogSubjectFor + coerceSpecCounts,
// PR #104) so a developer single-visual regenerate matches a full-site regenerate.
describe("catalogSubjectFor", () => {
  it("returns a male client for a barber shop", () => {
    expect(catalogSubjectFor("barber_shop")).toBe("a male client");
  });
  it("returns a female client for a beauty parlor", () => {
    expect(catalogSubjectFor("beauty_parlor")).toBe("a female client");
  });
  it("returns a neutral client for both / unknown", () => {
    expect(catalogSubjectFor("both")).toBe("a client");
    expect(catalogSubjectFor("anything_else")).toBe("a client");
  });
});

describe("buildServiceImagePrompt", () => {
  it("builds the exact gendered catalog prompt for a barber service", () => {
    expect(buildServiceImagePrompt("Skin Fade", "barber_shop")).toBe(
      "Photorealistic close-up of the finished Skin Fade result on a male client, flattering professional lighting, square format"
    );
  });
  it("builds the exact gendered catalog prompt for a beauty service", () => {
    expect(buildServiceImagePrompt("Balayage", "beauty_parlor")).toBe(
      "Photorealistic close-up of the finished Balayage result on a female client, flattering professional lighting, square format"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/worker && npx vitest run test/service-image-prompt.test.ts`
Expected: FAIL — `catalogSubjectFor`/`buildServiceImagePrompt` are not exported from `@repo/utils`.

- [ ] **Step 3: Write the helper**

Create `packages/utils/src/serviceImagePrompt.ts`:

```ts
/**
 * Subject phrase for AI service/hero imagery, chosen by shop type so a barber
 * shop shows men and a beauty parlor shows women (leaving the subject
 * unspecified produced e.g. all-female service photos on a barber shop).
 * "both" / unknown stays neutral. Mirrors the research worker's
 * catalogSubjectFor (PR #104) — keep the two byte-identical.
 */
export function catalogSubjectFor(shopType: string): string {
  if (shopType === "barber_shop") return "a male client";
  if (shopType === "beauty_parlor") return "a female client";
  return "a client";
}

/**
 * Deterministic per-service catalog image prompt. This is the SAME template the
 * research worker builds catalog[] from, so a developer regenerating one service
 * photo gets a result consistent with a full-site regenerate.
 */
export function buildServiceImagePrompt(serviceName: string, shopType: string): string {
  const subject = catalogSubjectFor(shopType);
  return `Photorealistic close-up of the finished ${serviceName} result on ${subject}, flattering professional lighting, square format`;
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/utils/src/index.ts`, add to the re-export block near the top (after `export * from "./designSpec";`):

```ts
export * from "./serviceImagePrompt";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/worker && npx vitest run test/service-image-prompt.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/utils/src/serviceImagePrompt.ts packages/utils/src/index.ts apps/worker/test/service-image-prompt.test.ts
git commit -m "feat(utils): shared gendered per-service image prompt helper"
```

---

### Task 3: DB query helpers for per-service image + hero/logo locks

**Files:**
- Modify: `apps/worker/src/db/queries.ts` (add helpers; widen two existing signatures)
- Test: `apps/worker/test/visual-editor.queries.test.ts`

**Interfaces:**
- Consumes: `DBService.image_url` (Task 1); the `shop_sites.locked_images_json` column (Task 1).
- Produces (all imported by Tasks 6-9):
  - `updateServiceImageUrl(db: D1Database, serviceId: string, shopId: string, url: string | null): Promise<...>`
  - `setShopSiteImageLock(db: D1Database, shopId: string, key: "hero" | "logo"): Promise<...>`
  - `clearShopSiteImageLock(db: D1Database, shopId: string, key: "hero" | "logo"): Promise<...>`
  - `getShopSiteImages(db: D1Database, shopId: string): Promise<{ hero_image_url: string | null; logo_url: string | null; locked_images_json: string | null; catalog_images_json: string | null } | null>`
  - `updateShopSiteHeroImageUrl` / `updateShopSiteLogoUrl` widened to accept `url: string | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/visual-editor.queries.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  updateServiceImageUrl,
  setShopSiteImageLock,
  clearShopSiteImageLock,
  getShopSiteImages,
} from "../src/db/queries";
import { seedShop } from "./helpers";

async function seedService(shopId: string, name: string): Promise<string> {
  const id = `svc-${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, ?, 30, 1000, 'Hair')"
  ).bind(id, shopId, name).run();
  return id;
}

async function seedActiveSite(shopId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO shop_sites (id, shop_id, template, status) VALUES (?, ?, 'minimal', 'active')"
  ).bind(`site-${crypto.randomUUID()}`, shopId).run();
}

describe("updateServiceImageUrl", () => {
  it("sets and clears a service's image_url, shop-scoped", async () => {
    const shopId = await seedShop("Q Shop");
    const svcId = await seedService(shopId, "Fade");
    await updateServiceImageUrl(env.DB, svcId, shopId, "https://x/service-1.png");
    let row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBe("https://x/service-1.png");
    await updateServiceImageUrl(env.DB, svcId, shopId, null);
    row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBeNull();
  });

  it("does not write a service in a different shop", async () => {
    const shopA = await seedShop("A");
    const shopB = await seedShop("B");
    const svcId = await seedService(shopA, "Cut");
    await updateServiceImageUrl(env.DB, svcId, shopB, "https://x/wrong.png");
    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBeNull();
  });
});

describe("hero/logo lock helpers", () => {
  it("sets then clears a lock key, round-tripping through JSON", async () => {
    const shopId = await seedShop("Lock Shop");
    await seedActiveSite(shopId);
    await setShopSiteImageLock(env.DB, shopId, "hero");
    let img = await getShopSiteImages(env.DB, shopId);
    expect(JSON.parse(img!.locked_images_json ?? "{}").hero).toBe(true);
    await setShopSiteImageLock(env.DB, shopId, "logo");
    img = await getShopSiteImages(env.DB, shopId);
    expect(JSON.parse(img!.locked_images_json ?? "{}").logo).toBe(true);
    await clearShopSiteImageLock(env.DB, shopId, "hero");
    img = await getShopSiteImages(env.DB, shopId);
    const parsed = JSON.parse(img!.locked_images_json ?? "{}");
    expect(parsed.hero).toBeUndefined();
    expect(parsed.logo).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/worker && npx vitest run test/visual-editor.queries.test.ts`
Expected: FAIL — the new helpers are not exported.

- [ ] **Step 3: Widen the two existing hero/logo setters to accept null**

In `apps/worker/src/db/queries.ts`, change both signatures (lines ~695 and ~708) from `url: string` to `url: string | null` (bodies unchanged — SQLite binds null fine):

```ts
export function updateShopSiteHeroImageUrl(
  db: D1Database,
  shopId: string,
  url: string | null,
) {
  return db
    .prepare(
      "UPDATE shop_sites SET hero_image_url = ? WHERE shop_id = ? AND status = 'active'",
    )
    .bind(url, shopId)
    .run();
}

export function updateShopSiteLogoUrl(
  db: D1Database,
  shopId: string,
  url: string | null,
) {
  return db
    .prepare(
      "UPDATE shop_sites SET logo_url = ? WHERE shop_id = ? AND status = 'active'",
    )
    .bind(url, shopId)
    .run();
}
```

- [ ] **Step 4: Add the new helpers**

In `apps/worker/src/db/queries.ts`, immediately after `updateShopSiteLogoUrl` (before `replaceShopSiteForShop`), add:

```ts
// ─── Visual Editor (per-service image + hero/logo lock flags) ─────────────────

/** Set or clear (`null`) a service's own photo. NULL reverts the card to the AI
 *  catalog pool. Shop-scoped so a stray/foreign service id cannot write across
 *  shops. */
export function updateServiceImageUrl(
  db: D1Database,
  serviceId: string,
  shopId: string,
  url: string | null,
) {
  return db
    .prepare("UPDATE services SET image_url = ? WHERE id = ? AND shop_id = ?")
    .bind(url, serviceId, shopId)
    .run();
}

/** Mark hero/logo custom so a full-site regenerate preserves it. Idempotent;
 *  initialises a NULL column to '{}' via COALESCE. */
export function setShopSiteImageLock(
  db: D1Database,
  shopId: string,
  key: "hero" | "logo",
) {
  return db
    .prepare(
      "UPDATE shop_sites SET locked_images_json = json_set(COALESCE(locked_images_json, '{}'), ?, json('true')) WHERE shop_id = ? AND status = 'active'",
    )
    .bind(`$.${key}`, shopId)
    .run();
}

/** Unmark hero/logo (Remove) so a later regenerate may overwrite it again. */
export function clearShopSiteImageLock(
  db: D1Database,
  shopId: string,
  key: "hero" | "logo",
) {
  return db
    .prepare(
      "UPDATE shop_sites SET locked_images_json = json_remove(COALESCE(locked_images_json, '{}'), ?) WHERE shop_id = ? AND status = 'active'",
    )
    .bind(`$.${key}`, shopId)
    .run();
}

/** Read the hero/logo/catalog/lock state the Visual Editor renders. */
export function getShopSiteImages(db: D1Database, shopId: string) {
  return db
    .prepare(
      "SELECT hero_image_url, logo_url, locked_images_json, catalog_images_json FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1",
    )
    .bind(shopId)
    .first<{
      hero_image_url: string | null;
      logo_url: string | null;
      locked_images_json: string | null;
      catalog_images_json: string | null;
    }>();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/worker && npx vitest run test/visual-editor.queries.test.ts`
Expected: PASS (confirms D1's JSON1 `json_set`/`json_remove`/`json('true')` work in the simulated D1).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/db/queries.ts apps/worker/test/visual-editor.queries.test.ts
git commit -m "feat(db): query helpers for per-service image + hero/logo locks"
```

---

### Task 4: Expose `services.image_url` in the public API and prefer it in the render

**Files:**
- Modify: `apps/worker/src/routes/services.ts:20-32` (`toPublicService`)
- Modify: `apps/web/app/routes/$shopSlug.tsx:14-21` (`ApiPublicService`) and `:69-83` (`mapApiServicesToCommercial`)
- Test (worker): `apps/worker/test/services.image-url.test.ts`
- Test (web): `apps/web/app/lib/shopServiceMapping.test.ts` (existing mapper test file)

**Interfaces:**
- Consumes: `DBService.image_url` (Task 1).
- Produces: `GET /api/shops/:shopId/services` items carry `image_url: string | null`; `mapApiServicesToCommercial` resolves `row.image_url || catalog[index] || ""`. Consumed by the public site and by Task 9's `services` shape.

- [ ] **Step 1: Write the failing worker test**

Create `apps/worker/test/services.image-url.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop } from "./helpers";

describe("GET /api/shops/:shopId/services image_url", () => {
  it("returns each service's image_url (null when unset)", async () => {
    const shopId = await seedShop("Img Shop");
    const withImg = `svc-${crypto.randomUUID()}`;
    const without = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, image_url) VALUES (?, ?, 'A', 30, 1000, 'Hair', ?)"
    ).bind(withImg, shopId, "https://x/service-A.png").run();
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'B', 30, 1000, 'Hair')"
    ).bind(without, shopId).run();

    const res = await dispatch("GET", `/api/shops/${shopId}/services`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; image_url: string | null }> };
    const a = body.data.find((s) => s.id === withImg);
    const b = body.data.find((s) => s.id === without);
    expect(a?.image_url).toBe("https://x/service-A.png");
    expect(b?.image_url).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/services.image-url.test.ts`
Expected: FAIL — `image_url` is `undefined` in the response (whitelist omits it).

- [ ] **Step 3: Add `image_url` to `toPublicService`**

In `apps/worker/src/routes/services.ts`, extend the returned object (after `isActive`):

```ts
function toPublicService(row: DBService) {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    description: "",
    durationMinutes: row.duration_min,
    price_pence: row.price_pence,
    category: row.category ?? "",
    isActive: row.is_active === 1,
    image_url: row.image_url ?? null,
  };
}
```

- [ ] **Step 4: Run the worker test to verify it passes**

Run: `cd apps/worker && npx vitest run test/services.image-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing web mapper test**

Append to `apps/web/app/lib/shopServiceMapping.test.ts` (import `mapApiServicesToCommercial` from `~/routes/$shopSlug` the same way the file already imports the mappers):

```ts
describe("mapApiServicesToCommercial image resolution", () => {
  it("prefers a service's own image_url over the positional catalog", () => {
    const rows = [
      { id: "s1", name: "A", durationMinutes: 30, price_pence: 1000, category: "Hair", image_url: "https://x/custom.png" },
      { id: "s2", name: "B", durationMinutes: 30, price_pence: 1000, category: "Hair", image_url: null },
    ];
    const catalog = ["https://x/cat0.png", "https://x/cat1.png"];
    const out = mapApiServicesToCommercial(rows, catalog);
    expect(out[0].image_url).toBe("https://x/custom.png"); // custom wins
    expect(out[1].image_url).toBe("https://x/cat1.png");   // falls back to catalog[index]
  });

  it("falls back to an imageless card when neither is present", () => {
    const rows = [{ id: "s1", name: "A", durationMinutes: 30, price_pence: 1000, category: "Hair", image_url: null }];
    const out = mapApiServicesToCommercial(rows, []);
    expect(out[0].image_url).toBe("");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/web && npx vitest run app/lib/shopServiceMapping.test.ts`
Expected: FAIL — the current mapper ignores `image_url` (always `catalog[index] || ""`); and `ApiPublicService` has no `image_url`, so the object literal fails type-check under vitest's esbuild.

- [ ] **Step 7: Add `image_url` to `ApiPublicService` and prefer it in the mapper**

In `apps/web/app/routes/$shopSlug.tsx`, extend the type (line 14):

```ts
type ApiPublicService = {
  id: string;
  name: string;
  description?: string;
  durationMinutes: number;
  price_pence: number;
  category?: string;
  image_url?: string | null;
};
```

And change the mapper body (line 81) from `image_url: catalog[index] || "",` to:

```ts
    // Custom per-service photo wins; else the positional AI pool; else imageless.
    image_url: row.image_url || catalog[index] || "",
```

(Leave `normalizeCommercialServices` untouched — it already honours `raw.image_url ?? catalog[index]`.)

- [ ] **Step 8: Run both tests to verify they pass**

Run: `cd apps/web && npx vitest run app/lib/shopServiceMapping.test.ts`
Expected: PASS.
Run: `cd apps/worker && npx vitest run test/services.image-url.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/routes/services.ts apps/worker/test/services.image-url.test.ts apps/web/app/routes/$shopSlug.tsx apps/web/app/lib/shopServiceMapping.test.ts
git commit -m "feat(site): expose services.image_url and prefer it over the catalog pool"
```

---

### Task 5: `upload-image` accepts `type = service:<id>`

**Files:**
- Modify: `apps/worker/src/routes/shops.ts:861-899` (`upload-image` handler); add `getServiceById` to the queries import.
- Test: `apps/worker/test/visual-editor.upload.test.ts`

**Interfaces:**
- Consumes: `getServiceById` (existing), auth pattern.
- Produces: `POST /:shopId/upload-image` with `type` = `hero | logo | service:<serviceId>`; stores R2 at `shops/<slug>/service-<serviceId>.png`; returns `{ imageUrl }`. The existing web proxy `api.shops.$shopId.upload-image.tsx` forwards the multipart body verbatim (type passes through) — no proxy change.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/visual-editor.upload.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { seedShop, seedUser, tokenFor } from "./helpers";

async function uploadImage(shopId: string, token: string, type: string): Promise<Response> {
  const fd = new FormData();
  fd.set("type", type);
  fd.set("file", new File([new Uint8Array([1, 2, 3, 4])], "x.png", { type: "image/png" }));
  const req = new Request(`https://worker.test/api/shops/${shopId}/upload-image`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req as never, env as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return res as unknown as Response;
}

describe("upload-image service:<id>", () => {
  it("accepts service:<id> for a service in the shop and returns an imageUrl", async () => {
    const shopId = await seedShop("Up Shop");
    const dev = await tokenFor(await seedUser("developer", null), "developer", null);
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'Fade', 30, 1000, 'Hair')"
    ).bind(svcId, shopId).run();

    const res = await uploadImage(shopId, dev, `service:${svcId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imageUrl?: string };
    expect(body.imageUrl).toContain(`/service-${svcId}.png`);
  });

  it("404s for a service not in the shop", async () => {
    const shopId = await seedShop("Up Shop 2");
    const other = await seedShop("Other Shop");
    const dev = await tokenFor(await seedUser("developer", null), "developer", null);
    const foreign = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'X', 30, 1000, 'Hair')"
    ).bind(foreign, other).run();

    const res = await uploadImage(shopId, dev, `service:${foreign}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/visual-editor.upload.test.ts`
Expected: FAIL — current handler rejects any `type` other than `hero`/`logo` with 400.

- [ ] **Step 3: Add `getServiceById` to the queries import in shops.ts**

In `apps/worker/src/routes/shops.ts`, add `getServiceById` (and later-task helpers now to avoid re-editing the import) to the existing `from "../db/queries.js"` import list:

```ts
  getServiceById,
  updateServiceImageUrl,
  setShopSiteImageLock,
  clearShopSiteImageLock,
  getShopSiteImages,
  getServicesByShop,
```

(Add only the names not already imported. `updateShopSiteHeroImageUrl`, `updateShopSiteLogoUrl`, `ensureDraftShopSiteRow` are already available.)

- [ ] **Step 4: Extend the `upload-image` type parsing and key**

In the `upload-image` handler, replace the type block (currently lines ~877-879) and the filename line (~888) so it accepts `service:<id>`:

```ts
  const typeRaw = form.type;
  const type = typeof typeRaw === "string" ? typeRaw : "";
  const serviceMatch = /^service:(.+)$/.exec(type);
  const isBrand = type === "hero" || type === "logo";
  if (!isBrand && !serviceMatch) {
    return c.json({ success: false, error: "type must be logo, hero or service:<id>" }, 400);
  }
  if (serviceMatch) {
    const svc = await getServiceById(c.env.DB, serviceMatch[1]);
    if (!svc || svc.shop_id !== shop.id) {
      return c.json({ success: false, error: "Service not found" }, 404);
    }
  }
  const file = form.file;
  if (!(file instanceof File) || file.size === 0) {
    return c.json({ success: false, error: "file required" }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json({ success: false, error: "File too large (max 5MB)" }, 400);
  }

  const filename = serviceMatch ? `service-${serviceMatch[1]}.png` : `${type}.png`;
```

(Everything below `const key = ...` stays: R2 put + `assetPublicUrl(c, shop.slug, filename)` + `return c.json({ imageUrl })`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/worker && npx vitest run test/visual-editor.upload.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/routes/shops.ts apps/worker/test/visual-editor.upload.test.ts
git commit -m "feat(api): upload-image accepts service:<id> per-service photos"
```

---

### Task 6: `save-image` accepts `service:<id>` and locks hero/logo

**Files:**
- Modify: `apps/worker/src/routes/shops.ts:903-931` (`save-image` handler)
- Test: `apps/worker/test/visual-editor.save.test.ts`

**Interfaces:**
- Consumes: `getServiceById`, `updateServiceImageUrl`, `updateShopSiteHeroImageUrl`, `updateShopSiteLogoUrl`, `setShopSiteImageLock`, `ensureDraftShopSiteRow`.
- Produces: `POST /:shopId/save-image` with `type` = `hero | logo | service:<id>`, body `{ type, imageUrl }`. Persists per-service `image_url`, or hero/logo url + sets the lock. Existing web proxy `api.shops.$shopId.save-image.tsx` forwards the body — no proxy change.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/visual-editor.save.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

async function seedActiveSite(shopId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO shop_sites (id, shop_id, template, status) VALUES (?, ?, 'minimal', 'active')"
  ).bind(`site-${crypto.randomUUID()}`, shopId).run();
}

describe("save-image", () => {
  it("writes services.image_url for service:<id>", async () => {
    const shopId = await seedShop("Save Shop");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'Fade', 30, 1000, 'Hair')"
    ).bind(svcId, shopId).run();

    const res = await dispatch("POST", `/api/shops/${shopId}/save-image`, {
      headers: dev,
      body: { type: `service:${svcId}`, imageUrl: "https://x/service.png" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBe("https://x/service.png");
  });

  it("sets hero url and marks it locked", async () => {
    const shopId = await seedShop("Save Shop 2");
    await seedActiveSite(shopId);
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));

    const res = await dispatch("POST", `/api/shops/${shopId}/save-image`, {
      headers: dev,
      body: { type: "hero", imageUrl: "https://x/hero.png" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT hero_image_url, locked_images_json FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ hero_image_url: string | null; locked_images_json: string | null }>();
    expect(row?.hero_image_url).toBe("https://x/hero.png");
    expect(JSON.parse(row?.locked_images_json ?? "{}").hero).toBe(true);
  });

  it("lets an admin of the shop save (upload path is not developer-only)", async () => {
    const shopId = await seedShop("Save Shop 3");
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category) VALUES (?, ?, 'Cut', 30, 1000, 'Hair')"
    ).bind(svcId, shopId).run();
    const admin = authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
    const res = await dispatch("POST", `/api/shops/${shopId}/save-image`, {
      headers: admin,
      body: { type: `service:${svcId}`, imageUrl: "https://x/admin.png" },
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/visual-editor.save.test.ts`
Expected: FAIL — current handler rejects `service:<id>` (400) and does not set `locked_images_json`.

- [ ] **Step 3: Rewrite the `save-image` body**

Replace the body of the `save-image` handler after the auth check (currently lines ~913-930) with:

```ts
  const body = await c.req
    .json<{ type?: string; imageUrl?: string }>()
    .catch((): { type?: string; imageUrl?: string } => ({}));
  const type = typeof body.type === "string" ? body.type : "";
  const serviceMatch = /^service:(.+)$/.exec(type);
  const isHero = type === "hero";
  const isLogo = type === "logo";
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  if ((!isHero && !isLogo && !serviceMatch) || !imageUrl) {
    return c.json({ success: false, error: "type and imageUrl required" }, 400);
  }

  if (serviceMatch) {
    const svc = await getServiceById(c.env.DB, serviceMatch[1]);
    if (!svc || svc.shop_id !== shop.id) {
      return c.json({ success: false, error: "Service not found" }, 404);
    }
    await updateServiceImageUrl(c.env.DB, serviceMatch[1], shop.id, imageUrl);
  } else {
    await ensureDraftShopSiteRow(c.env.DB, shop.id);
    if (isHero) {
      await updateShopSiteHeroImageUrl(c.env.DB, shop.id, imageUrl);
      await setShopSiteImageLock(c.env.DB, shop.id, "hero");
    } else {
      await updateShopSiteLogoUrl(c.env.DB, shop.id, imageUrl);
      await setShopSiteImageLock(c.env.DB, shop.id, "logo");
    }
  }

  await c.env.KV.delete(`site:${shop.slug}`);
  return c.json({ ok: true });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/worker && npx vitest run test/visual-editor.save.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/shops.ts apps/worker/test/visual-editor.save.test.ts
git commit -m "feat(api): save-image handles service:<id> and locks custom hero/logo"
```

---

### Task 7: `generate-image` developer-only + `service:<id>`, persists and locks

**Files:**
- Modify: `apps/worker/src/routes/shops.ts:738-857` (`generate-image` handler); add `buildServiceImagePrompt` to the `@repo/utils` import.
- Test: `apps/worker/test/visual-editor.generate-auth.test.ts`

**Interfaces:**
- Consumes: `buildServiceImagePrompt` (Task 2), `getServiceById`, `updateServiceImageUrl`, `updateShopSiteHeroImageUrl`, `updateShopSiteLogoUrl`, `setShopSiteImageLock`, `ensureDraftShopSiteRow`, existing `generateOpenRouterImageBuffer`, `assetPublicUrl`.
- Produces: `POST /:shopId/generate-image` is **developer-only**; `type` = `hero | logo | service:<id>`; generates, uploads to the stable R2 key, persists (`services.image_url` or hero/logo url + lock), busts KV, returns `{ imageUrl }`. Existing web proxy forwards JSON — no proxy change.

> This narrows the endpoint from dev-or-admin to developer-only. Verified there is no admin UI caller (the admin/dev "Generate new images" flow is `generate-site`, not `generate-image`), so no used capability is removed.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/visual-editor.generate-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

describe("generate-image auth + type", () => {
  it("403s for an admin of the shop (regenerate is developer-only)", async () => {
    const shopId = await seedShop("Gen Shop");
    const admin = authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: admin,
      body: { type: "logo" },
    });
    expect(res.status).toBe(403);
  });

  it("400s for an unknown type from a developer", async () => {
    const shopId = await seedShop("Gen Shop 2");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: dev,
      body: { type: "banner" },
    });
    expect(res.status).toBe(400);
  });

  it("404s for a developer regenerating a service not in the shop", async () => {
    const shopId = await seedShop("Gen Shop 3");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-image`, {
      headers: dev,
      body: { type: `service:svc-${crypto.randomUUID()}` },
    });
    expect(res.status).toBe(404);
  });
});
```

(These assert auth/validation, which run before any OpenRouter call — no network needed. The existing `model-validation.test.ts` cases that hit `generate-image` as a developer with `type: "logo"` still pass because developers keep access.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/visual-editor.generate-auth.test.ts`
Expected: FAIL — an admin currently gets past the auth check (dev-or-admin), and `type: "service:..."` is rejected as invalid before the ownership 404.

- [ ] **Step 3: Add the prompt helper import**

In `apps/worker/src/routes/shops.ts`, add `buildServiceImagePrompt` to the existing `from "@repo/utils"` import block.

- [ ] **Step 4: Narrow the auth check to developer-only**

In `generate-image`, replace the auth check (lines ~744-746):

```ts
  if (user.role !== "developer") {
    return c.json({ error: "Forbidden" }, 403);
  }
```

- [ ] **Step 5: Extend type parsing (accept `service:<id>`, validate ownership)**

Replace the type-parse block (lines ~792-813) with:

```ts
  const typeRaw = body.type;
  const type = typeof typeRaw === "string" ? typeRaw : "";
  const serviceMatch = /^service:(.+)$/.exec(type);
  const isHero = type === "hero";
  const isLogo = type === "logo";
  if (!isHero && !isLogo && !serviceMatch) {
    console.error("[generate-image] invalid or missing type", { shopId: shop.id, typeField: typeRaw });
    return c.json({ error: `Invalid field "type": must be "logo", "hero" or "service:<id>"` }, 400);
  }
  let serviceRow: Awaited<ReturnType<typeof getServiceById>> = null;
  if (serviceMatch) {
    serviceRow = await getServiceById(c.env.DB, serviceMatch[1]);
    if (!serviceRow || serviceRow.shop_id !== shop.id) {
      return c.json({ error: "Service not found" }, 404);
    }
  }
```

- [ ] **Step 6: Build the prompt, aspect ratio and filename per type**

Replace the prompt/aspect/filename block (lines ~824-833) with:

```ts
  const shopTypeLabel = shop.type.replace(/_/g, " ");

  const prompt = serviceMatch
    ? buildServiceImagePrompt(serviceRow!.name, shop.type)
    : isHero
      ? `Cinematic interior of a ${shopTypeLabel} called ${shop.name}. ${notes}. Professional photography, dramatic lighting, no people, wide angle.`
      : `Minimalist professional logo for ${shop.name}. ${notes}. Clean lines, scalable, white background.`;

  const aspectRatio = isHero ? "16:9" : "1:1";
  const filename = serviceMatch ? `service-${serviceMatch[1]}.png` : `${type}.png`;
  const key = `shops/${shop.slug}/${filename}`;
```

- [ ] **Step 7: Persist the result and lock, then bust KV**

Replace the success branch of the try (currently lines ~843-845, `await c.env.ASSETS.put(...)` through `return c.json({ imageUrl });`) with:

```ts
    await c.env.ASSETS.put(key, buf, { httpMetadata: { contentType: "image/png" } });
    const imageUrl = assetPublicUrl(c, shop.slug, filename);

    if (serviceMatch) {
      await updateServiceImageUrl(c.env.DB, serviceMatch[1], shop.id, imageUrl);
    } else {
      await ensureDraftShopSiteRow(c.env.DB, shop.id);
      if (isHero) {
        await updateShopSiteHeroImageUrl(c.env.DB, shop.id, imageUrl);
        await setShopSiteImageLock(c.env.DB, shop.id, "hero");
      } else {
        await updateShopSiteLogoUrl(c.env.DB, shop.id, imageUrl);
        await setShopSiteImageLock(c.env.DB, shop.id, "logo");
      }
    }
    await c.env.KV.delete(`site:${shop.slug}`);

    return c.json({ imageUrl });
```

Also update the empty-body error text (line ~786) to mention `service:<id>`:

```ts
          'Empty request body: send JSON with required field "type" ("logo", "hero" or "service:<id>"); optional "image_model" and "design_notes".',
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/worker && npx vitest run test/visual-editor.generate-auth.test.ts test/model-validation.test.ts`
Expected: PASS (new auth/type tests pass; the existing developer-path model-validation tests still pass).

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/routes/shops.ts apps/worker/test/visual-editor.generate-auth.test.ts
git commit -m "feat(api): generate-image is developer-only, handles service:<id>, persists + locks"
```

---

### Task 8: New `remove-image` endpoint (developer-only) + web proxy

**Files:**
- Modify: `apps/worker/src/routes/shops.ts` (add handler after `save-image`)
- Create: `apps/web/app/routes/api.shops.$shopId.remove-image.tsx`
- Test: `apps/worker/test/visual-editor.remove.test.ts`

**Interfaces:**
- Consumes: `getServiceById`, `updateServiceImageUrl`, `updateShopSiteHeroImageUrl`, `updateShopSiteLogoUrl`, `clearShopSiteImageLock`.
- Produces: `POST /:shopId/remove-image` (developer-only), body `{ type }`, `type` = `hero | logo | service:<id>`; clears the value + lock; busts KV; returns `{ ok: true }`. Web resource route `proxyShopPost(args, "remove-image", { forwardBody: true })`.

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/visual-editor.remove.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

describe("remove-image", () => {
  it("clears a service's image_url (developer)", async () => {
    const shopId = await seedShop("Rm Shop");
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, image_url) VALUES (?, ?, 'Fade', 30, 1000, 'Hair', 'https://x/a.png')"
    ).bind(svcId, shopId).run();

    const res = await dispatch("POST", `/api/shops/${shopId}/remove-image`, {
      headers: dev,
      body: { type: `service:${svcId}` },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT image_url FROM services WHERE id = ?").bind(svcId).first<{ image_url: string | null }>();
    expect(row?.image_url).toBeNull();
  });

  it("clears hero url and its lock (developer)", async () => {
    const shopId = await seedShop("Rm Shop 2");
    await env.DB.prepare(
      "INSERT INTO shop_sites (id, shop_id, template, status, hero_image_url, locked_images_json) VALUES (?, ?, 'minimal', 'active', 'https://x/hero.png', '{\"hero\":true}')"
    ).bind(`site-${crypto.randomUUID()}`, shopId).run();
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));

    const res = await dispatch("POST", `/api/shops/${shopId}/remove-image`, {
      headers: dev,
      body: { type: "hero" },
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT hero_image_url, locked_images_json FROM shop_sites WHERE shop_id = ?").bind(shopId).first<{ hero_image_url: string | null; locked_images_json: string | null }>();
    expect(row?.hero_image_url).toBeNull();
    expect(JSON.parse(row?.locked_images_json ?? "{}").hero).toBeUndefined();
  });

  it("403s for an admin of the shop (remove is developer-only)", async () => {
    const shopId = await seedShop("Rm Shop 3");
    const admin = authHeaders(await tokenFor(await seedUser("admin", shopId), "admin", shopId));
    const res = await dispatch("POST", `/api/shops/${shopId}/remove-image`, {
      headers: admin,
      body: { type: "hero" },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/visual-editor.remove.test.ts`
Expected: FAIL — the route does not exist (404).

- [ ] **Step 3: Add the `remove-image` handler**

In `apps/worker/src/routes/shops.ts`, immediately after the `save-image` handler (after its closing `});` at ~line 931), add:

```ts
// ─── POST /api/shops/:shopId/remove-image — clear a visual (developer-only) ───

shops.post("/:shopId/remove-image", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer") {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ type?: string }>().catch((): { type?: string } => ({}));
  const type = typeof body.type === "string" ? body.type : "";
  const serviceMatch = /^service:(.+)$/.exec(type);
  const isHero = type === "hero";
  const isLogo = type === "logo";
  if (!isHero && !isLogo && !serviceMatch) {
    return c.json({ success: false, error: "type must be logo, hero or service:<id>" }, 400);
  }

  if (serviceMatch) {
    const svc = await getServiceById(c.env.DB, serviceMatch[1]);
    if (!svc || svc.shop_id !== shop.id) {
      return c.json({ success: false, error: "Service not found" }, 404);
    }
    await updateServiceImageUrl(c.env.DB, serviceMatch[1], shop.id, null);
  } else if (isHero) {
    await updateShopSiteHeroImageUrl(c.env.DB, shop.id, null);
    await clearShopSiteImageLock(c.env.DB, shop.id, "hero");
  } else {
    await updateShopSiteLogoUrl(c.env.DB, shop.id, null);
    await clearShopSiteImageLock(c.env.DB, shop.id, "logo");
  }

  await c.env.KV.delete(`site:${shop.slug}`);
  return c.json({ ok: true });
});
```

- [ ] **Step 4: Add the web proxy resource route**

Create `apps/web/app/routes/api.shops.$shopId.remove-image.tsx`:

```ts
import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { proxyShopPost } from "~/lib/worker-proxy";

export const action = (args: ActionFunctionArgs) => proxyShopPost(args, "remove-image", { forwardBody: true });
```

- [ ] **Step 5: Run the worker test to verify it passes**

Run: `cd apps/worker && npx vitest run test/visual-editor.remove.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check web**

Run: `cd apps/web && npx tsc`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/routes/shops.ts apps/web/app/routes/api.shops.$shopId.remove-image.tsx apps/worker/test/visual-editor.remove.test.ts
git commit -m "feat(api): remove-image endpoint (developer-only) + web proxy"
```

---

### Task 9: `GET /visuals` read endpoint

**Files:**
- Modify: `apps/worker/src/routes/shops.ts` (add handler near the other image routes)
- Test: `apps/worker/test/visual-editor.visuals.test.ts`

**Interfaces:**
- Consumes: `getShopSiteImages`, `getServicesByShop`, auth pattern.
- Produces: `GET /:shopId/visuals` (developer or admin-of-shop) → `{ success: true, data: { hero: {url, locked}, logo: {url, locked}, catalog: string[], services: {id, name, image_url}[] } }`. Consumed by both dashboards (Tasks 12, 13).

- [ ] **Step 1: Write the failing test**

Create `apps/worker/test/visual-editor.visuals.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";

describe("GET /visuals", () => {
  it("returns hero/logo/lock/catalog/services for a developer", async () => {
    const shopId = await seedShop("Vis Shop");
    await env.DB.prepare(
      "INSERT INTO shop_sites (id, shop_id, template, status, hero_image_url, logo_url, locked_images_json, catalog_images_json) VALUES (?, ?, 'minimal', 'active', 'https://x/hero.png', 'https://x/logo.png', '{\"hero\":true}', '[\"https://x/c0.png\"]')"
    ).bind(`site-${crypto.randomUUID()}`, shopId).run();
    const svcId = `svc-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, image_url) VALUES (?, ?, 'Fade', 30, 1000, 'Hair', 'https://x/svc.png')"
    ).bind(svcId, shopId).run();
    const dev = authHeaders(await tokenFor(await seedUser("developer", null), "developer", null));

    const res = await dispatch("GET", `/api/shops/${shopId}/visuals`, { headers: dev });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        hero: { url: string | null; locked: boolean };
        logo: { url: string | null; locked: boolean };
        catalog: string[];
        services: Array<{ id: string; name: string; image_url: string | null }>;
      };
    };
    expect(body.data.hero).toEqual({ url: "https://x/hero.png", locked: true });
    expect(body.data.logo).toEqual({ url: "https://x/logo.png", locked: false });
    expect(body.data.catalog).toEqual(["https://x/c0.png"]);
    expect(body.data.services).toEqual([{ id: svcId, name: "Fade", image_url: "https://x/svc.png" }]);
  });

  it("403s for an admin of a different shop", async () => {
    const shopId = await seedShop("Vis Shop 2");
    const otherShop = await seedShop("Vis Other");
    const admin = authHeaders(await tokenFor(await seedUser("admin", otherShop), "admin", otherShop));
    const res = await dispatch("GET", `/api/shops/${shopId}/visuals`, { headers: admin });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/worker && npx vitest run test/visual-editor.visuals.test.ts`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Add the `visuals` handler**

In `apps/worker/src/routes/shops.ts`, after the `remove-image` handler, add:

```ts
// ─── GET /api/shops/:shopId/visuals — Visual Editor read model ────────────────

shops.get("/:shopId/visuals", authMiddleware, async (c) => {
  const user = getUser(c);
  const param = c.req.param("shopId");
  const shop =
    (await getShopBySlug(c.env.DB, param)) ?? (await getShopById(c.env.DB, param));
  if (!shop) return c.json({ success: false, error: "Shop not found" }, 404);
  if (user.role !== "developer" && (user.role !== "admin" || user.shop_id !== shop.id)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  const site = await getShopSiteImages(c.env.DB, shop.id);
  let locked: Record<string, unknown> = {};
  try {
    locked = site?.locked_images_json ? (JSON.parse(site.locked_images_json) as Record<string, unknown>) : {};
  } catch {
    locked = {};
  }
  let catalog: string[] = [];
  try {
    const parsed = site?.catalog_images_json ? (JSON.parse(site.catalog_images_json) as unknown) : [];
    if (Array.isArray(parsed)) catalog = parsed.map((x) => (typeof x === "string" ? x : ""));
  } catch {
    catalog = [];
  }
  const services = (await getServicesByShop(c.env.DB, shop.id)).map((s) => ({
    id: s.id,
    name: s.name,
    image_url: s.image_url ?? null,
  }));

  return c.json({
    success: true,
    data: {
      hero: { url: site?.hero_image_url ?? null, locked: locked.hero === true },
      logo: { url: site?.logo_url ?? null, locked: locked.logo === true },
      catalog,
      services,
    },
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/worker && npx vitest run test/visual-editor.visuals.test.ts`
Expected: PASS.

- [ ] **Step 5: Full worker suite + type-check**

Run: `cd apps/worker && npm test && npx tsc --noEmit`
Expected: PASS (all Visual Editor endpoints + existing suite green).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/routes/shops.ts apps/worker/test/visual-editor.visuals.test.ts
git commit -m "feat(api): GET /visuals read model for the Visual Editor"
```

---

### Task 10: Assembler preserves locked hero/logo on regenerate (manual-deploy worker)

**Files:**
- Create: `apps/workers/builder/src/lockedImages.ts`
- Create: `apps/workers/builder/src/lockedImages.test.ts`
- Modify: `apps/workers/builder/package.json` (add `vitest` devDep + `test` script)
- Modify: `apps/workers/builder/src/index.ts:392-393` (compute hero/logo from existing + locks)

**Interfaces:**
- Consumes: the `shop_sites.locked_images_json` column (Task 1).
- Produces: `parseLockedImages(json)` and `resolveRegeneratedImageUrls({...})` used by the assembler's `shop_sites` UPDATE.

> `apps/workers/builder` is a standalone, manual-deploy worker: it is NOT in the root workspaces, so its test runs via `cd apps/workers/builder && npm test`, not `turbo run test`. Per-service customs already survive automatically (the `services` table is untouched by regenerate); this task only adds hero/logo preservation.

- [ ] **Step 1: Write the failing test**

Create `apps/workers/builder/src/lockedImages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseLockedImages, resolveRegeneratedImageUrls } from "./lockedImages";

describe("parseLockedImages", () => {
  it("reads hero/logo true flags", () => {
    expect(parseLockedImages('{"hero":true}')).toEqual({ hero: true, logo: false });
  });
  it("tolerates null and garbage", () => {
    expect(parseLockedImages(null)).toEqual({});
    expect(parseLockedImages("not json")).toEqual({});
  });
});

describe("resolveRegeneratedImageUrls", () => {
  it("keeps the existing url for a locked slot, takes generated for an unlocked slot", () => {
    const out = resolveRegeneratedImageUrls({
      existingHero: "https://x/old-hero.png",
      existingLogo: "https://x/old-logo.png",
      generatedHero: "https://x/new-hero.png",
      generatedLogo: "https://x/new-logo.png",
      locked: { hero: true, logo: false },
    });
    expect(out).toEqual({ hero: "https://x/old-hero.png", logo: "https://x/new-logo.png" });
  });
  it("with no locks (fresh INSERT path) takes all generated", () => {
    const out = resolveRegeneratedImageUrls({
      existingHero: null,
      existingLogo: null,
      generatedHero: "https://x/new-hero.png",
      generatedLogo: "https://x/new-logo.png",
      locked: {},
    });
    expect(out).toEqual({ hero: "https://x/new-hero.png", logo: "https://x/new-logo.png" });
  });
});
```

- [ ] **Step 2: Add vitest to the builder and run to verify it fails**

In `apps/workers/builder/package.json`, add a `test` script and the `vitest` devDep:

```json
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "typescript": "^5.9.2",
    "vitest": "^2.1.9",
    "wrangler": "^4.74.0"
  }
```

Run: `cd apps/workers/builder && npm install && npm test`
Expected: FAIL — `./lockedImages` does not exist.

- [ ] **Step 3: Write the helper**

Create `apps/workers/builder/src/lockedImages.ts`:

```ts
export interface LockedImages {
  hero?: boolean;
  logo?: boolean;
}

/** Parse shop_sites.locked_images_json into flags; tolerant of NULL/garbage. */
export function parseLockedImages(json: string | null | undefined): LockedImages {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return { hero: o.hero === true, logo: o.logo === true };
  } catch {
    return {};
  }
}

/**
 * Decide hero/logo urls to persist on regenerate: a locked slot keeps its
 * EXISTING url (owner/developer customisation survives); an unlocked slot takes
 * the freshly generated url. The fresh-INSERT path passes no existing row and
 * empty locks, so it takes all generated.
 */
export function resolveRegeneratedImageUrls(args: {
  existingHero: string | null;
  existingLogo: string | null;
  generatedHero: string | null;
  generatedLogo: string | null;
  locked: LockedImages;
}): { hero: string | null; logo: string | null } {
  return {
    hero: args.locked.hero ? args.existingHero : args.generatedHero,
    logo: args.locked.logo ? args.existingLogo : args.generatedLogo,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/workers/builder && npm test`
Expected: PASS.

- [ ] **Step 5: Wire the assembler to preserve locks**

In `apps/workers/builder/src/index.ts`, add the import at the top (with the other local imports):

```ts
import { parseLockedImages, resolveRegeneratedImageUrls } from "./lockedImages";
```

Then replace lines 392-393:

```ts
  const hero_image_url = images.heroUrl?.trim() || null;
  const logo_url = images.logoUrl?.trim() || null;
```

with:

```ts
  // Preserve a customised (locked) hero/logo across a regenerate. Read the
  // existing active row; for a locked slot keep its stored url instead of the
  // freshly generated one. No existing row (fresh INSERT) => nothing locked.
  const existingRow = await env.DB.prepare(
    "SELECT hero_image_url, logo_url, locked_images_json FROM shop_sites WHERE shop_id = ? AND status = 'active' LIMIT 1"
  )
    .bind(shopId)
    .first<{ hero_image_url: string | null; logo_url: string | null; locked_images_json: string | null }>();
  const resolvedImages = resolveRegeneratedImageUrls({
    existingHero: existingRow?.hero_image_url ?? null,
    existingLogo: existingRow?.logo_url ?? null,
    generatedHero: images.heroUrl?.trim() || null,
    generatedLogo: images.logoUrl?.trim() || null,
    locked: parseLockedImages(existingRow?.locked_images_json),
  });
  const hero_image_url = resolvedImages.hero;
  const logo_url = resolvedImages.logo;
```

(The downstream UPDATE/INSERT that bind `hero_image_url`/`logo_url` are unchanged.)

- [ ] **Step 6: Type-check the builder**

Run: `cd apps/workers/builder && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/workers/builder/src/lockedImages.ts apps/workers/builder/src/lockedImages.test.ts apps/workers/builder/package.json apps/workers/builder/src/index.ts
git commit -m "feat(assembler): preserve locked hero/logo across a full regenerate"
```

---

### Task 11: Shared `VisualManager` component

**Files:**
- Create: `apps/web/app/components/VisualManager.tsx`
- Create: `apps/web/app/components/VisualManager.test.tsx`

**Interfaces:**
- Consumes: the visuals shape from `GET /visuals` (Task 9); `resolvePublicAssetImageUrl`, `withImageCacheBust` from `~/components/dev-shops/helpers`; the endpoints `upload-image`, `save-image`, `generate-image`, `remove-image`.
- Produces: `export type VisualsData`, `export function VisualManager(props: VisualManagerProps)`, and `export async function uploadVisual(shopId, type, file, doFetch?)`. Consumed by Tasks 12 and 13.

> **Test harness (verified — do not deviate):** `apps/web/vitest.config.ts` already sets `environment: "jsdom"` globally for `app/**/*.test.{ts,tsx}`, so no per-file docblock is needed. `@testing-library/react` is **not** installed; the one existing component test (`apps/web/app/components/BookingConfirmMap.test.tsx`) renders with `renderToStaticMarkup` from `react-dom/server` and asserts on the HTML string. Match that pattern — do not add testing-library. The two-request upload flow is tested through the exported pure `uploadVisual` helper (no DOM interaction needed). `~/components/dev-shops/helpers` and `~/components/ui/Button` were verified to have no top-level `@remix-run/react` import, but the mock still uses `importActual` so only `useRevalidator` is overridden.

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/components/VisualManager.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VisualManager, uploadVisual, type VisualsData } from "./VisualManager";

// VisualManager calls useRevalidator(); provide it without a Router but keep
// every other @remix-run/react export real so nothing transitive breaks.
vi.mock("@remix-run/react", async (importActual) => ({
  ...(await importActual<typeof import("@remix-run/react")>()),
  useRevalidator: () => ({ revalidate: () => {}, state: "idle" as const }),
}));

const DATA: VisualsData = {
  hero: { url: "https://x/hero.png", locked: true },
  logo: { url: null, locked: false },
  catalog: ["https://x/c0.png"],
  services: [{ id: "s1", name: "Skin Fade", image_url: null }],
};

describe("VisualManager render", () => {
  it("shows a Custom badge on a locked visual and the service name", () => {
    const html = renderToStaticMarkup(
      <VisualManager shopId="shop1" apiUrl="https://api" role="developer" {...DATA} />
    );
    expect(html).toContain("Custom");
    expect(html).toContain("Skin Fade");
  });

  it("shows Regenerate/Remove for developer but not for admin", () => {
    const dev = renderToStaticMarkup(
      <VisualManager shopId="shop1" apiUrl="https://api" role="developer" {...DATA} />
    );
    const admin = renderToStaticMarkup(
      <VisualManager shopId="shop1" apiUrl="https://api" role="admin" {...DATA} />
    );
    expect(dev).toContain("Regenerate");
    expect(dev).toContain("Remove");
    expect(admin).toContain("Upload");
    expect(admin).not.toContain("Regenerate");
    expect(admin).not.toContain("Remove");
  });
});

describe("uploadVisual", () => {
  it("calls upload-image then save-image with the same type", async () => {
    const calls: Array<{ url: string; type: string | null }> = [];
    const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/upload-image")) {
        const fd = init?.body as FormData;
        calls.push({ url, type: String(fd.get("type")) });
        return new Response(JSON.stringify({ imageUrl: "https://x/up.png" }), { status: 200 });
      }
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { type?: string; imageUrl?: string };
      calls.push({ url, type: parsed.type ?? null });
      expect(parsed.imageUrl).toBe("https://x/up.png");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    const result = await uploadVisual("shop1", "service:s1", file, doFetch as unknown as typeof fetch);

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/shops/shop1/upload-image",
      "/api/shops/shop1/save-image",
    ]);
    expect(calls[0].type).toBe("service:s1");
    expect(calls[1].type).toBe("service:s1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run app/components/VisualManager.test.tsx`
Expected: FAIL — `./VisualManager` (and its `uploadVisual` export) does not exist.

- [ ] **Step 3: Write the component**

Create `apps/web/app/components/VisualManager.tsx`:

```tsx
import { useRef, useState } from "react";
import { useRevalidator } from "@remix-run/react";
import { Check, Loader2, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "~/components/ui/Button";
import { resolvePublicAssetImageUrl, withImageCacheBust } from "~/components/dev-shops/helpers";

export interface VisualsData {
  hero: { url: string | null; locked: boolean };
  logo: { url: string | null; locked: boolean };
  catalog: string[];
  services: { id: string; name: string; image_url: string | null }[];
}

export interface VisualManagerProps extends VisualsData {
  shopId: string;
  apiUrl: string;
  role: "developer" | "admin";
}

/**
 * Upload flow, extracted so it is unit-testable without DOM interaction:
 * POST upload-image (multipart) then POST save-image (json) with the SAME type.
 * `doFetch` is injectable for tests; defaults to the global fetch.
 */
export async function uploadVisual(
  shopId: string,
  type: string,
  file: File,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const fd = new FormData();
  fd.set("type", type);
  fd.set("file", file);
  const upRes = await doFetch(`/api/shops/${shopId}/upload-image`, { method: "POST", body: fd });
  const upJson = (await upRes.json().catch(() => ({}))) as { imageUrl?: string; error?: string };
  const url = typeof upJson.imageUrl === "string" ? upJson.imageUrl.trim() : "";
  if (!upRes.ok || !url) return { ok: false, error: upJson.error?.trim() || "Upload failed." };
  const svRes = await doFetch(`/api/shops/${shopId}/save-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, imageUrl: url }),
  });
  const svJson = (await svRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!svRes.ok || svJson.ok === false) {
    return { ok: false, error: svJson.error?.trim() || "Could not save the image." };
  }
  return { ok: true };
}

interface Tile {
  /** Wire type sent to the endpoints: "hero" | "logo" | `service:<id>`. */
  type: string;
  label: string;
  /** Current image to preview (custom, else catalog fallback), or null. */
  url: string | null;
  /** Custom => shows the badge; a service is custom when it has its own image. */
  locked: boolean;
}

export function VisualManager({ shopId, apiUrl, role, hero, logo, catalog, services }: VisualManagerProps) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bust, setBust] = useState(0);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const tiles: Tile[] = [
    { type: "hero", label: "Hero", url: hero.url, locked: hero.locked },
    { type: "logo", label: "Logo", url: logo.url, locked: logo.locked },
    ...services.map((s, i) => ({
      type: `service:${s.id}`,
      label: s.name,
      url: s.image_url || catalog[i] || null,
      locked: s.image_url != null,
    })),
  ];

  async function post(path: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
    const res = await fetch(`/api/shops/${shopId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && json.ok !== false && !json.error, json };
  }

  async function handleUpload(type: string, file: File) {
    if (busy) return;
    setError(null);
    setBusy(type);
    try {
      const result = await uploadVisual(shopId, type, file);
      if (!result.ok) {
        setError(result.error ?? "Upload failed.");
        return;
      }
      setBust(Date.now());
      revalidator.revalidate();
    } catch {
      setError("Could not upload the image. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRegenerate(type: string) {
    if (busy) return;
    setError(null);
    setBusy(type);
    try {
      const res = await fetch(`/api/shops/${shopId}/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const json = (await res.json().catch(() => ({}))) as { imageUrl?: string; error?: string };
      if (!res.ok || !json.imageUrl) {
        setError(json.error?.trim() || "Could not regenerate the image.");
        return;
      }
      setBust(Date.now());
      revalidator.revalidate();
    } catch {
      setError("Could not regenerate the image. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(type: string) {
    if (busy) return;
    setError(null);
    setBusy(type);
    try {
      const removed = await post("remove-image", { type });
      if (!removed.ok) {
        setError((removed.json.error as string)?.trim() || "Could not remove the image.");
        return;
      }
      setBust(Date.now());
      revalidator.revalidate();
    } catch {
      setError("Could not remove the image. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
      <h2 className="font-heading text-lg font-semibold text-white">Visuals</h2>
      <p className="mt-1 text-sm text-white/50">
        {role === "developer"
          ? "Upload, regenerate or remove any single image. Uploaded and regenerated images are kept when the site is regenerated."
          : "Upload your own image for any visual. Uploaded images are kept when the site is regenerated."}
      </p>
      {error ? (
        <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => {
          const src = tile.url
            ? withImageCacheBust(resolvePublicAssetImageUrl(tile.url, apiUrl), bust)
            : "";
          const tileBusy = busy === tile.type;
          return (
            <div
              key={tile.type}
              data-testid={`visual-tile-${tile.type}`}
              className="rounded-lg border border-white/10 bg-white/[0.03] p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="truncate text-sm font-medium text-white/80">{tile.label}</span>
                {tile.locked ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-xs text-gold">
                    <Check className="h-3 w-3" /> Custom
                  </span>
                ) : null}
              </div>
              <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black/30">
                {src ? (
                  <img src={src} alt={`${tile.label} preview`} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-xs text-white/40">No image</span>
                )}
              </div>
              <input
                ref={(el) => {
                  fileInputs.current[tile.type] = el;
                }}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleUpload(tile.type, f);
                }}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={tileBusy}
                  onClick={() => fileInputs.current[tile.type]?.click()}
                >
                  {tileBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1 h-3.5 w-3.5" />}
                  Upload
                </Button>
                {role === "developer" ? (
                  <>
                    <Button type="button" variant="ghost" size="sm" disabled={tileBusy} onClick={() => void handleRegenerate(tile.type)}>
                      <Sparkles className="mr-1 h-3.5 w-3.5" /> Regenerate
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={tileBusy} onClick={() => void handleRemove(tile.type)}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run app/components/VisualManager.test.tsx`
Expected: PASS. No new devDep is needed — jsdom is configured globally and the test uses `renderToStaticMarkup` (react-dom/server), matching `BookingConfirmMap.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/VisualManager.tsx apps/web/app/components/VisualManager.test.tsx
git commit -m "feat(web): shared role-aware VisualManager component"
```

---

### Task 12: Wire `VisualManager` into the developer hub

**Files:**
- Modify: `apps/web/app/routes/dev.shops.$shopId.tsx` (loader fetches `/visuals`, passes via Outlet context)
- Modify: `apps/web/app/routes/dev.shops.$shopId._index.tsx` (replace the "Brand images" section with `VisualManager`; remove the now-dead brand-image code)

**Interfaces:**
- Consumes: `GET /visuals` (Task 9), `VisualManager` + `VisualsData` (Task 11).
- Produces: the dev hub renders `<VisualManager role="developer" ... />` covering logo, hero and every service.

- [ ] **Step 1: Fetch visuals in the layout loader and thread through context**

In `apps/web/app/routes/dev.shops.$shopId.tsx`, import the type and fetch the read model in the loader, then add it to the Outlet context:

```ts
import type { VisualsData } from "~/components/VisualManager";
```

In `loader`, after `ownerDetails` is resolved and before the `return json(...)`:

```ts
  let visuals: VisualsData | null = null;
  try {
    visuals = await api.get<VisualsData>(`/api/shops/${shop.id}/visuals`);
  } catch {
    visuals = null;
  }

  return json({ shop, apiUrl: env.API_URL, generationPrefs, ownerDetails, visuals });
```

In the component, destructure and pass it:

```tsx
  const { shop, apiUrl, generationPrefs, ownerDetails, visuals } = useLoaderData<typeof loader>();
  ...
      <Outlet context={{ shop, apiUrl, generationPrefs, ownerDetails, visuals }} />
```

- [ ] **Step 2: Replace the "Brand images" section in the detail page**

In `apps/web/app/routes/dev.shops.$shopId._index.tsx`:

1. Add to the imports:

```ts
import { VisualManager, type VisualsData } from "~/components/VisualManager";
```

2. Extend the `OutletCtx` type (line 31) and destructure `visuals`:

```ts
type OutletCtx = {
  shop: Shop;
  apiUrl: string;
  generationPrefs: DevGenerationPrefs;
  ownerDetails: DevShopOwnerDetails | null;
  visuals: VisualsData | null;
};
```

```tsx
  const { shop, apiUrl, generationPrefs, ownerDetails, visuals } = useOutletContext<OutletCtx>();
```

3. Delete the now-dead brand-image state/handler (lines ~193-241): `imgBusy`, `imgError`, `logoBust`, `heroBust`, `logoInputRef`, `heroInputRef`, `logoSrc`, `heroSrc`, and the whole `handleImageUpload` function. Remove now-unused imports (`Upload` if unused elsewhere; keep `Loader2`, `Check`, `Sparkles`, `Trash2`, `UserCircle` if still used — check before deleting each).

4. Replace the entire "Brand images" `<section>` (lines ~482-543) with:

```tsx
      {/* ── Visuals (logo, hero, per-service photos) ──────────────────────────── */}
      {visuals ? (
        <VisualManager role="developer" shopId={shop.id} apiUrl={apiUrl} {...visuals} />
      ) : (
        <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-lg font-semibold text-white">Visuals</h2>
          <p className="mt-1 text-sm text-white/50">Visuals are unavailable for this shop right now.</p>
        </section>
      )}
```

- [ ] **Step 3: Type-check web**

Run: `cd apps/web && npx tsc`
Expected: PASS (no unused-variable or missing-prop errors; if any brand-image leftover is still referenced, remove it).

- [ ] **Step 4: Run the web test suite**

Run: `cd apps/web && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/routes/dev.shops.$shopId.tsx apps/web/app/routes/dev.shops.$shopId._index.tsx
git commit -m "feat(dev): replace Brand images with the full VisualManager"
```

---

### Task 13: Admin "Visuals" route + nav item

**Files:**
- Create: `apps/web/app/routes/admin.visuals.tsx`
- Modify: `apps/web/app/components/dashboards/Sidebar.tsx` (add the nav item)

**Interfaces:**
- Consumes: `GET /visuals` (Task 9), `VisualManager` + `VisualsData` (Task 11), the `resolveShopId` developer-support pattern (mirrors `admin.services.tsx`).
- Produces: `/admin/visuals` renders `<VisualManager role="admin" ... />` for the admin's own shop.

- [ ] **Step 1: Add the nav item**

In `apps/web/app/components/dashboards/Sidebar.tsx`, add `Image` to the `lucide-react` import (aliased to avoid the DOM `Image` global):

```ts
  Image as ImageIcon,
```

Then add to `ADMIN_NAV`, immediately after the Services entry:

```ts
  { href: "/admin/visuals", label: "Visuals", icon: ImageIcon },
```

- [ ] **Step 2: Create the admin route**

Create `apps/web/app/routes/admin.visuals.tsx` (mirrors `admin.services.tsx`'s loader + shell):

```tsx
import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import type { SessionPayload } from "~/lib/auth";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { VisualManager, type VisualsData } from "~/components/VisualManager";

function resolveShopId(request: Request, user: SessionPayload): string | null {
  const url = new URL(request.url);
  if (user.role === "developer") return url.searchParams.get("shopId")?.trim() || null;
  return user.shop_id?.trim() || null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = resolveShopId(request, user);

  let visuals: VisualsData | null = null;
  if (shopId) {
    try {
      visuals = await api.get<VisualsData>(`/api/shops/${shopId}/visuals`);
    } catch {
      visuals = null;
    }
  }

  return json({
    visuals,
    shopId,
    apiUrl: env.API_URL,
    developerNeedsShop: user.role === "developer" && !shopId,
  });
}

export default function AdminVisuals() {
  const { visuals, shopId, apiUrl, developerNeedsShop } = useLoaderData<typeof loader>();

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-bold text-white">Visuals</h1>
        <p className="mt-0.5 text-sm text-white/60">
          Upload your own logo, hero or service photos. Your images are kept when the site is regenerated.
        </p>
      </div>

      {developerNeedsShop ? (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage visuals as a developer.
        </div>
      ) : null}

      {shopId && visuals ? (
        <VisualManager role="admin" shopId={shopId} apiUrl={apiUrl} {...visuals} />
      ) : !developerNeedsShop ? (
        <p className="text-sm text-white/60">Visuals are unavailable for this shop right now.</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Type-check web**

Run: `cd apps/web && npx tsc`
Expected: PASS.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `npm run dev` (repo root), then:
- As developer, open `/dev/shops/<id>` → the Visuals section shows logo, hero and a tile per service, each with Upload / Regenerate / Remove and a Custom badge on locked visuals.
- As admin, open `/admin/visuals` → the same tiles with Upload only.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/routes/admin.visuals.tsx apps/web/app/components/dashboards/Sidebar.tsx
git commit -m "feat(admin): Visuals dashboard route + sidebar nav"
```

---

### Task 14: Full verification, lint, and deploy notes

**Files:** none (verification + docs)

- [ ] **Step 1: Type-check and test everything from the repo root**

Run: `npm run check-types`
Expected: PASS across `apps/web`, `apps/worker`, `packages/utils`.

Run: `npm test`
Expected: PASS (root `turbo run test` covers `apps/worker`, `apps/web`, `packages/utils`). This does NOT include the builder — run it separately:

Run: `cd apps/workers/builder && npm test`
Expected: PASS.

- [ ] **Step 2: Lint / format**

Run: `npm run lint` and `npx prettier --write "apps/**/*.{ts,tsx}" "packages/**/*.ts"`
Expected: clean.

- [ ] **Step 3: Record the deploy split for the PR description**

Note in the PR body:
- CI (push to `main`) ships: migration 045 (runs on main-worker deploy), the main-worker endpoints, the public `image_url` API, and all web changes.
- **Manual step (developer):** `cd apps/workers/builder && npx wrangler deploy` to ship the assembler lock-preservation change. Until this is deployed, a full regenerate still overwrites a locked hero/logo (per-service customs already survive without it).
- The research worker is **not** changed here; the shared `@repo/utils` prompt is main-worker-only for the MVP (deferred follow-up: rewire research to import it; independent of PR #104).

- [ ] **Step 4: Update the memory file**

Update `visual-editor-design.md` STATUS to reflect: plan written + executed; note the manual assembler deploy and the deferred research rewire.

---

## Self-Review

**Spec coverage:**
- Data model migration 045 (`services.image_url` + `shop_sites.locked_images_json`) → Task 1. ✅
- Custom/locked semantics (service custom ⟺ image_url; hero/logo custom ⟺ lock key) → Tasks 3, 6, 8, 9, 11. ✅
- `upload-image` service:<id> → Task 5. ✅ `save-image` service:<id> + hero/logo lock → Task 6. ✅ `generate-image` developer-only + service:<id> + shared gendered prompt + persist/lock → Tasks 2, 7. ✅ `remove-image` new dev-only + web proxy → Task 8. ✅
- Public render: `image_url` in the API + `mapApiServicesToCommercial` prefers it; `normalizeCommercialServices` left as-is → Task 4. ✅
- Regenerate stickiness: per-service automatic (services table untouched); hero/logo via assembler lock-preservation → Task 10. ✅
- Shared `VisualManager`, role-gated, both surfaces → Tasks 11, 12, 13. ✅
- Auth server-side (regenerate/remove 403 for admin) → Tasks 7, 8 tests. ✅
- Testing (worker endpoints, role enforcement, ownership, lock writes, visuals, assembler preservation, migration replay; web mapper + component) → Tasks 1-13. ✅
- Rollout / deploy split → Task 14. ✅
- **Deferred (surfaced, not silently dropped):** research worker sharing the `@repo/utils` prompt (spec said "main worker and research"); the secondary cost optimisation of skipping AI-gen for locked visuals (spec explicitly non-goal for MVP).

**Placeholder scan:** No TBD/TODO; every code and test step shows full code; commands have expected output.

**Type consistency:** `VisualsData` shape (`hero/logo: {url, locked}`, `catalog: string[]`, `services: {id,name,image_url}[]`) is identical in Task 9 (endpoint), Task 11 (component), Task 12 and Task 13 (loaders). Endpoint `type` wire values (`hero | logo | service:<id>`) match across Tasks 5-9 and the component. Helper names (`updateServiceImageUrl`, `setShopSiteImageLock`, `clearShopSiteImageLock`, `getShopSiteImages`, `buildServiceImagePrompt`, `parseLockedImages`, `resolveRegeneratedImageUrls`) are used consistently where declared.
