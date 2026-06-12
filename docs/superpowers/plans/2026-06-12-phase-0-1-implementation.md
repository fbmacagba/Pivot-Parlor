# Phase 0+1 Implementation Plan — Prep + Critical Security

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the unit-test harness and close the four critical security holes (dev-account bootstrap takeover, schedule IDOR, waitlist IDOR, remotely-triggerable E2E fixture backdoor) with regression tests.

**Architecture:** Surgical changes to `apps/worker` routes + a vitest-pool-workers harness running against a local simulated D1 seeded from `schema.sql`. One branch `remediation/phase-0-1`, one PR (Phase 0 alone has no deployable behavior change, so it rides with Phase 1).

**Tech stack:** Hono 4, Cloudflare Workers, D1, vitest + `@cloudflare/vitest-pool-workers`.

**Baseline caveat:** `apps/worker` currently has 23 known `tsc` errors in `dashboard.ts`/`shops.ts`/`walkin.ts` (fixed in Phase 3). The gate for this phase is **no NEW type errors** (error count ≤ baseline) — record the exact baseline in Task 1.

---

### Task 1: Branch + baseline (T0.1)

- [ ] **Step 1:** `git checkout -b remediation/phase-0-1` (repo: `pivot-parlor/`, currently on `main`; uncommitted docs from the planning session ride along and are committed first as `docs: add README, PRD, remediation plans`).
- [ ] **Step 2:** Record baselines:
  - `cd apps/worker && npx tsc --noEmit 2>&1 | Measure-Object -Line` → record N (expected ≈23 errors).
  - `npm run build` at root → must pass.

### Task 2: `.env.example` (T0.3)

- [ ] **Step 1:** Create `.env.example`:

```
# Copy to .env (gitignored). Never commit real values.
JWT_SECRET=           # must match the deployed Worker secret (wrangler secret put JWT_SECRET)
DEV_PASSWORD=         # local developer account password
E2E_BASE_URL=         # Playwright target. NEVER point at production.
```

### Task 3: Secret-rotation runbook (T0.2 — prod rotation is a USER action)

- [ ] **Step 1:** Create `docs/runbooks/secret-rotation.md` documenting: generate new `JWT_SECRET` (`openssl rand -hex 32`), set via `wrangler secret put JWT_SECRET` (worker) + `wrangler pages secret put JWT_SECRET --project-name pivot-parlor-web`, update local `.env`, note all sessions are invalidated; `DEV_PASSWORD` rotation via `scripts/reset-dev-password.mjs` (upgraded in Task 7 to emit an UPSERT).
- [ ] **Step 2:** Do NOT execute rotation autonomously — flag to the user at handoff (production-impacting; logs out all users; needs authenticated wrangler).

### Task 4: Vitest harness (T0.4)

**Files:** Create `apps/worker/vitest.config.ts`, `apps/worker/test/apply-schema.ts`, `apps/worker/test/smoke.test.ts`; Modify `apps/worker/package.json`, `apps/worker/tsconfig.json` (exclude `test/` from build if needed), `turbo.json`, root `package.json`.

- [ ] **Step 1:** `npm install -D vitest @cloudflare/vitest-pool-workers --workspace=worker` (let npm resolve compatible versions; pool-workers pins its supported vitest range).
- [ ] **Step 2:** `apps/worker/vitest.config.ts`:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/apply-schema.ts"],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2024-10-22",
          d1Databases: ["DB"],
          kvNamespaces: ["KV"],
          bindings: { JWT_SECRET: "test-secret" },
        },
      },
    },
  },
});
```

- [ ] **Step 3:** `apps/worker/test/apply-schema.ts` — import `schema.sql` with `?raw`, split on `;`, run each statement against `env.DB` in `beforeAll`. Also apply any migration files whose tables are touched by tests (none needed for Phase 1 — staff/schedules/waitlist/invites/platform_users/shops are all in base schema; verify and adjust).
- [ ] **Step 4:** `test/smoke.test.ts`: insert + select a row through `env.DB`; assert round-trip.
- [ ] **Step 5:** `package.json` (worker): `"test": "vitest run"`. `turbo.json`: add `"test": { "dependsOn": ["^build"] }` task (no cache inputs issue; keep simple). Root `package.json`: `"test": "turbo run test"`.
- [ ] **Step 6:** Run `npm test --workspace=worker` → smoke passes. Commit `test(worker): add vitest-pool-workers harness with D1 schema setup`.

**Fallback** if pool-workers fights the toolchain (>~30 min of fighting): plain `vitest` (node env) + a ~60-line fake D1 (`prepare/bind/first/all/run`) backed by `better-sqlite3`, same test API surface. Note the substitution in the commit message.

### Task 5: Schedule IDOR fix (T1.2)

**Files:** Modify `apps/worker/src/routes/schedule.ts:30-34`; Test `apps/worker/test/schedule.idor.test.ts`.

- [ ] **Step 1:** Failing test: seed two shops A/B + staff in each; JWT for admin of A (sign with `hono/jwt`, secret `test-secret`); `GET /api/shops/{A}/schedule/{staffB}` → expect 404; `GET /api/shops/{A}/schedule/{staffA}` → 200.
- [ ] **Step 2:** Fix:

```ts
schedule.get("/:staffId", async (c) => {
  const shopId = c.req.param("shopId")!;
  const staffId = c.req.param("staffId")!;
  const member = await getStaffById(c.env.DB, staffId);
  if (!member || member.shop_id !== shopId) {
    return c.json({ success: false, error: "Staff member not found" }, 404);
  }
  const rows = await getScheduleByStaff(c.env.DB, staffId);
  return c.json({ success: true, data: rows });
});
```

(`getStaffById` already exists — `db/queries.ts:651`.)
- [ ] **Step 3:** Also fix `PUT /` (same file): entries carry `staff_id` — validate every distinct `staff_id` in the payload belongs to `shopId` before upserting; 400 `"staff_id does not belong to this shop"` otherwise. Add test.
- [ ] **Step 4:** Tests green → commit `fix(worker): scope schedule reads/writes to the shop in the URL`.

### Task 6: Waitlist IDOR fix (T1.3)

**Files:** Modify `apps/worker/src/routes/waitlist.ts:56-68`; Test `apps/worker/test/waitlist.idor.test.ts`.

- [ ] **Step 1:** Failing tests: (a) admin of shop A PATCHes entry of shop B → 404; (b) role `customer` PATCHes any entry → 403; (c) admin of shop B PATCHes own entry → 200 + status updated; (d) developer PATCHes any entry → 200.
- [ ] **Step 2:** Fix — load entry, require role + shop match:

```ts
waitlist.patch("/:id/status", authMiddleware, async (c) => {
  const user = getUser(c);
  if (!user || !["developer", "admin", "staff"].includes(user.role)) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }
  const { id } = c.req.param();
  const body = await c.req.json<{ status?: string }>();
  const valid = ["waiting", "notified", "booked", "expired"];
  if (!body.status || !valid.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${valid.join(", ")}` }, 400);
  }
  const entry = await c.env.DB
    .prepare("SELECT shop_id FROM waitlist WHERE id = ?")
    .bind(id)
    .first<{ shop_id: string }>();
  if (!entry || (user.role !== "developer" && user.shop_id !== entry.shop_id)) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  await c.env.DB.prepare("UPDATE waitlist SET status = ? WHERE id = ?").bind(body.status, id).run();
  return c.json({ success: true });
});
```

(import `getUser` from `../middleware/auth.js`.)
- [ ] **Step 3:** Tests green → commit `fix(worker): scope waitlist status updates to caller's shop and role`.

### Task 7: Remove dev bootstrap (T1.1)

**Files:** Modify `apps/worker/src/routes/auth.ts:50-66`, `scripts/reset-dev-password.mjs`; Test `apps/worker/test/auth.bootstrap.test.ts`.

- [ ] **Step 1:** Failing test: `POST /auth/login` with `dev@pivotparlor.com` + any password against a DB with no such user → 401 AND `platform_users` stays empty.
- [ ] **Step 2:** Delete the bootstrap block (auth.ts lines 52-66), leaving:

```ts
const user = await getUserByEmail(c.env.DB, body.email);
if (!user) return c.json({ success: false, error: "Invalid credentials" }, 401);
```

- [ ] **Step 3:** Upgrade `scripts/reset-dev-password.mjs` to emit an **UPSERT** (INSERT with fixed UUID `ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash`) so a fresh database can still be seeded deliberately. Keep print-SQL behavior (script never touches prod itself). Note: requires a unique index/constraint on `platform_users.email` — verify in schema.sql; if absent, key the upsert on a `SELECT`-then-branch in the emitted SQL instead.
- [ ] **Step 4:** Tests green → commit `fix(worker): remove first-login developer bootstrap (account-takeover vector)`.

### Task 8: Gate E2E fixtures (T1.5)

**Files:** Modify `apps/worker/src/bindings.ts`, `apps/worker/src/routes/invites.ts` (all `X-E2E-Test-Mock` branches), grep for other `X-E2E-Test-Mock`/`e2eMock` sites and gate identically; Test `apps/worker/test/invites.e2e-gate.test.ts`.

- [ ] **Step 1:** Failing test: with `E2E_FIXTURES` unset, `GET /api/invites/{64×a}` with header `X-E2E-Test-Mock: 1` → 404 and no shop/invite rows created. With `E2E_FIXTURES="true"` binding → fixture path works (200).
- [ ] **Step 2:** `bindings.ts`: add `E2E_FIXTURES?: string;`. In each mock branch: `const e2eMock = c.env.E2E_FIXTURES === "true" && c.req.header("X-E2E-Test-Mock") === "1";`
- [ ] **Step 3:** Set `E2E_FIXTURES = "true"` only in `wrangler.dev.toml` `[vars]` (and later staging env). NOT in production `wrangler.toml`.
- [ ] **Step 4:** Tests green → commit `fix(worker): gate E2E fixture backdoor behind E2E_FIXTURES env var`.

### Task 9: IDOR sweep (T1.4)

- [ ] **Step 1:** Enumerate every route handler reading a bare row id (`c.req.param("id"|"staffId"|"bookingId"|"serviceId"|...)`) across `apps/worker/src/routes/*.ts`; for each, confirm the loaded row's `shop_id` is checked against `requireShop()`'s `:shopId` param or the caller's shop.
- [ ] **Step 2:** Fix any further instances using the Task 5/6 pattern (load → compare `shop_id` → 404), each with a regression test.
- [ ] **Step 3:** Document the sweep result (routes checked, verdicts) in the PR description. Commit per fix.

### Task 10: Verify + hand off

- [ ] **Step 1:** `npm test --workspace=worker` green; `cd apps/worker && npx tsc --noEmit` error count ≤ Task-1 baseline; `npm run build` passes at root.
- [ ] **Step 2:** Push branch, open PR `remediation: phase 0+1 — test harness + critical security fixes` with the sweep table; list the user actions: (1) approve/merge, (2) run secret rotation per runbook, (3) confirm `E2E_FIXTURES` stays unset in prod.

## Self-review checklist
- Spec coverage: T0.1✓(Task1) T0.2✓(Task3) T0.3✓(Task2) T0.4✓(Task4) T1.1✓(Task7) T1.2✓(Task5) T1.3✓(Task6) T1.4✓(Task9) T1.5✓(Task8).
- No placeholders: code shown for every behavioral change; Task 9 is investigative by nature with a defined pattern to apply.
- Type consistency: `getStaffById` exists at `queries.ts:651`; `getUser` exported from `middleware/auth.ts` (verify export — if it's only in rbac.ts's import list it exists; confirmed used by rbac.ts:3).
