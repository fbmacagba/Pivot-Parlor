# React Router 7 Move: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `apps/web` from Remix 2.17.5 to react-router 7.18.5 on Cloudflare Pages without changing anything a visitor sees, so that the website's runtime advisories (wrjc, 337j, rxv8) go.

**Architecture:** The work ships in two PRs.
- **PR A** carries every change that works under both routers: the load-context shape, the error classifiers, the revalidation opt-in, and a type check of `functions/`. It ships and bakes on today's Remix.
- **PR B** is the swap: packages, config, entries, a scripted rename of imports, guards and E2E. It ships as one release, because single fetch cannot ship on Remix 2 and React Router 7 cannot run without it.

**Tech Stack:** React 18.3.1, Vite 6.4.6, react-router / @react-router/{cloudflare,dev,fs-routes} 7.18.5, Cloudflare Pages Functions, vitest (jsdom), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-react-router-7-design.md` (merged in #184). Step 0's results are summarised under "Step 0 rulings" below, and Task 10 writes them into the spec.

## Global Constraints

- **Dependency swap.** Exactly this, nothing else:
  - remove `@remix-run/cloudflare`, `@remix-run/cloudflare-pages`, `@remix-run/react`, `@remix-run/dev`;
  - add `react-router` and `@react-router/cloudflare` as dependencies, and `@react-router/dev` and `@react-router/fs-routes` as devDependencies, each at `^7.18.5`;
  - remove the root overrides `react-router`, `react-router-dom` and `@remix-run/router`, and keep `miniflare > undici`.
- **Versions stay.** React stays 18.3.1 and Vite stays ^6.4.6. No React Router v8 future flags.
- **`react-router.config.ts`:** `ssr: true` and `routeDiscovery: { mode: "initial" }`.
- **Never commit `legacy-peer-deps`.** A clean `npm ci` must leave `package-lock.json` byte-identical.
- **`react-router` and every `@react-router/*` package resolve from the root `node_modules`.**
- **Keep the custom `app/entry.server.tsx` and `app/entry.client.tsx`.** Without a custom server entry, `react-router dev` edits `package.json` and runs `npm install` by itself (seen in Step 0).
- **The middleware reads only `context.cloudflare.*`** (`env`, `ctx.waitUntil`, `data.cspNonce`), never the top-level event fields.
- **Repo rules:**
  - Run `aramid check --staged` before every commit, and `npx eslint` on changed files. Never `--no-verify`.
  - Stage explicit paths. Never stage `.aramid/`, `.githooks/`, `.graphite/`, `.impeccable/` or `.superpowers/`.
  - Commit messages go in a file and are committed with `git commit -F`. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Merges and deploys:** each merge needs the owner's OK. Use `gh pr merge N --merge`, never `--auto`. PR B gets the `e2e` label.
- **Copy:** no dashes in user-facing text.
- **Production:** no probe POSTs. Sign-in and sign-out are tested only through Playwright against staging.
- **Graph first:** `/c/Python314/python.exe -P -m graphite` for cross-file questions. Grep and Glob are for literal text.

## Step 0 rulings (measured 2026-11-14 on a throwaway branch)

1. **Install.** A plain `npm install` of the swap succeeds; no override and no flag are needed.
   - `react-router` lands nested in `apps/web/node_modules`. Drop that lockfile entry, delete the directory and run `npm install` again: npm then hoists it.
   - After that, `npm ci` reproduces the lockfile byte for byte, and `npm audit` reads 32 → 14 on the real install.
   - The `@cloudflare/workers-types` "invalid" that `npm ls` reports (wrangler's optional peer wants ^5) already exists on main. It is out of scope.
2. **Resource routes.** `Response.json(x, init)` and `data(x, init)` answer identically:
   - a plain `fetch` gets `application/json`, with status and headers kept;
   - a fetcher gets the same `fetcher.data`, through `/path.data?_routes=…` for GET and `/path.data` for POST, as `text/x-script`.

   **Ruling:** every `json` import becomes `import { data as json } from "react-router"`. That leaves about 250 call sites untouched. Renaming the calls to `data(` would collide with an existing `data` variable in 26 of the 64 files.
3. **Routes.** `flatRoutes()` from `@react-router/fs-routes` gives the same 96 routes as Remix (id, parent, path, index, file), with 0 differences.
4. **Config.** `routeDiscovery: { mode: "initial" }` and `ssr` exist in 7.18.5.
5. **Load context.** The `getLoadContext` argument is `{ request, context: { cloudflare: { ...event, cf, ctx, caches } } }`, confirmed from `node_modules`.
   - Remix 2 already passes the same nested `context.cloudflare`, and its types mark the top-level fields `@deprecated use context.cloudflare.env`.
   - **Ruling:** PR A moves the middleware to the nested shape, so PR B touches only its import line.
6. **This plan departs from the spec in three places:**
   - **The spec's PR A item 4 is dropped** (moving raw-fetch resource routes to `Response.json`). Ruling 2 makes it unnecessary.
   - **The spec's `AppLoadContext` augmentation is dropped.** The app never augmented it, and React Router 7's default is the same open record.
   - **The functions type check runs after the build (`postbuild`), not in `check-types`.** CI type-checks before it builds, and the middleware imports `../build/server/index.js`. Running it in `postbuild` makes CI's Build step and every deploy build run it.

## Review Focus

1. **A loader failing on a `.data` request** reaches the alert email with the route pattern (`/book/:shopSlug`) and `where: "data"`. The slug value or the `.data` suffix must never appear in the route. Test in Task 2.
2. **A plain `fetch()` to a resource route** (the job-status polling on `setup.template-select.tsx` and `dev.shops.$shopId._index.tsx`) still receives `application/json`. Test in Task 8.
3. **A form posted with JavaScript off** (a document POST, not `.data`) still renders the page with the action's answer and its status. Test in Task 8.
4. **A booking that clashes (409)** reloads the shown times, so the taken slot disappears. Test in Task 4.
5. **Every inline script, including streamed data scripts,** carries the response's CSP nonce. `tests/e2e/csp-guard.spec.ts` checks this, re-measured in Task 9.

---

## Part A: PR A, preparation (branch `chore/rr7-prep`)

### Task 1: One load-context builder, read from `context.cloudflare`, with `functions/` type-checked

**Files:**
- Create: `apps/web/app/lib/loadContext.ts`, `apps/web/app/lib/loadContext.test.ts`, `apps/web/tsconfig.functions.json`
- Modify:
  - `apps/web/functions/_middleware.ts:33-49` (`getLoadContext`)
  - `apps/web/vite.config.ts:55-61` (the dev proxy's `getLoadContext`)
  - `apps/web/app/entry.server.tsx:18` (the cast)
  - `apps/web/package.json` (`postbuild`)

**Interfaces:**
- Produces, in `app/lib/loadContext.ts`:
  - `export interface CloudflareRequestContext { env: Record<string, unknown>; ctx: { waitUntil(promise: Promise<unknown>): void }; data?: Record<string, unknown> }`
  - `export interface WebLoadContext { env: Record<string, unknown>; waitUntil(promise: Promise<unknown>): void; cspNonce?: string }`
  - `export function webLoadContext(cloudflare: CloudflareRequestContext): WebLoadContext`

- [ ] **Step 1: Write `loadContext.test.ts`.** It contains:
  - `it("passes env through as the same object")`: `expect(webLoadContext(cf).env).toBe(cf.env)`.
  - `it("forwards waitUntil to ctx.waitUntil with the same promise")`: use a spy and `const p = Promise.resolve()`, then `expect(spy).toHaveBeenCalledWith(p)`.
  - `it("reads the CSP nonce from data")`: `data: { cspNonce: "abc" }` → `"abc"`.
  - `it("ignores a nonce that is not a string, or no data at all")`: `{ cspNonce: 7 }` → `undefined`, and no `data` → `undefined`.
- [ ] **Step 2: Run it.** `cd apps/web && npx vitest run app/lib/loadContext.test.ts`. Expected: FAIL, "Cannot find module './loadContext'".
- [ ] **Step 3: Implement `webLoadContext`.**
- [ ] **Step 4: Rerun Step 2.** Expected: 4 passed.
- [ ] **Step 5: Use it everywhere the load context is built.**
  - Middleware: `getLoadContext: ({ context }) => webLoadContext(context.cloudflare)`. Keep the doc comment and correct it: the values come from `context.cloudflare`.
  - `vite.config.ts`: `getLoadContext: ({ context }) => webLoadContext({ ...context.cloudflare, env: devEnv(context.cloudflare.env) })`. Keep `devEnv`.
  - `entry.server.tsx`: cast `loadContext` to `WebLoadContext & ReportingContext` instead of the inline type.
- [ ] **Step 6: Add `tsconfig.functions.json`:** `{ "extends": "./tsconfig.json", "include": ["functions/**/*.ts"], "exclude": ["node_modules"] }`. Then set `postbuild` to `node scripts/copy-public.mjs && tsc -p tsconfig.functions.json`.
- [ ] **Step 7: Prove the type check is red first.**
  - Change `context.cloudflare` to `context.cloudflair` in the middleware. Run `cd apps/web && npm run build`. Expected: exit 1, with TS2339 naming `_middleware.ts`.
  - Revert, rerun. Expected: exit 0.
- [ ] **Step 8: Check the dev server.** Run `npx vitest run app/lib/devServer.test.ts`. Expected: 10 passed (the dev load context is unchanged in shape).
- [ ] **Step 9: Commit:** "fix(web): the load context reads context.cloudflare, and functions/ is type-checked".

### Task 2: Server errors recognise the new data requests

**Files:** Modify `apps/web/app/lib/serverErrors.ts:92-96` (`whereOf`), and the route computation inside `reportServerError`. Test: `apps/web/app/lib/serverErrors.test.ts`.

**Interfaces:** Produces `export function dataRequestPath(pathname: string): string`. It strips a trailing `.data`, and maps `/_root.data` to `/`. `routePattern` callers in this file use it.

- [ ] **Step 1: Add the tests.**
  - In `describe("whereOf")`:
    - `whereOf(req("https://pivotparlor.com/book/x.data?_routes=routes%2F%24shopSlug.book"))` → `"data"`
    - `whereOf(req("https://pivotparlor.com/_root.data"))` → `"data"`
    - a POST to `/book/x.data` → `"action"`
    - `whereOf(req("https://pivotparlor.com/a.data/b"))` → `"page"`
    - keep the `?_data=` case.
  - A new `it("a failing .data request reports the route pattern, never the value or the suffix")`:
    - call `reportServerError` with `https://pivotparlor.com/book/ferdym.data?_routes=routes%2F%24shopSlug.book` and params `{ shopSlug: "ferdym" }`;
    - the binding receives `{ where: "data", route: "/book/:shopSlug" }`.
  - `dataRequestPath`: `"/_root.data"` → `"/"`, `"/book/x.data"` → `"/book/x"` and `"/book/x"` → `"/book/x"`.
- [ ] **Step 2: Run.** `npx vitest run app/lib/serverErrors.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - `whereOf`: a request is "data" when `?_data` is present **or** the pathname ends with `.data`.
  - `reportServerError` builds the pattern from `dataRequestPath(url.pathname)`.
- [ ] **Step 4: Rerun Step 2.** Expected: all pass.
- [ ] **Step 5: Commit:** "fix(web): server-error alerts recognise React Router's .data requests".

### Task 3: The browser-error reporter finds the route under either router

**Files:** Modify `apps/web/app/lib/browserErrorReporter.ts:32-39`. Test: `apps/web/app/lib/browserErrorReporter.test.ts`.

- [ ] **Step 1: Add `describe("default route lookup")`.**
  - Install with no `routeId` option, so the default is used, and trigger one own error.
  - Cases:
    - `window.__reactRouterDataRouter = { state: { matches: [{ route: { id: "root" } }, { route: { id: "routes/contact" } }] } }` → the report's route is `"routes/contact"`;
    - only `window.__remixRouter` with the same shape → `"routes/contact"`;
    - neither → `"unknown"`.
  - `afterEach` deletes both globals.
- [ ] **Step 2: Run.** `npx vitest run app/lib/browserErrorReporter.test.ts`. Expected: the first case FAILS (`"unknown"`).
- [ ] **Step 3: Implement.** `currentRouteId` reads `__reactRouterDataRouter ?? __remixRouter`. Rename the interface `RouterGlobal`.
- [ ] **Step 4: Rerun Step 2.** Expected: all pass.
- [ ] **Step 5: Commit:** "fix(web): browser-error alerts find the route under React Router 7 too".

### Task 4: A conflict (409) still refreshes the page's data

**Files:**
- Create: `apps/web/app/lib/revalidation.ts`, `apps/web/app/lib/revalidation.test.ts`
- Modify: `apps/web/app/lib/bookingUrl.ts:56-70`, plus each page route the inventory in Step 5 names
- Test: `apps/web/app/lib/bookingUrl.test.ts`

**Interfaces:** Produces `export const revalidateAfterConflict: ShouldRevalidateFunction`. It returns `true` when `actionStatus === 409`, and `defaultShouldRevalidate` otherwise. Import `ShouldRevalidateFunction` from `@remix-run/react` now; the Task 6 script moves it.

- [ ] **Step 1: Write the tests.**
  - `revalidation.test.ts`:
    - 409 with `defaultShouldRevalidate: false` → `true`;
    - 400 with default `false` → `false`;
    - no action, default `true` → `true`.
  - `bookingUrl.test.ts`:
    - a form submission with `actionStatus: 409` and `defaultShouldRevalidate: false` → `true`;
    - the same with 400 → `false`.
- [ ] **Step 2: Run.** `npx vitest run app/lib/revalidation.test.ts app/lib/bookingUrl.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `revalidateAfterConflict`.
  - `skipRevalidationForWizardParams` returns `revalidateAfterConflict(args)` for a form submission.
  - Why it matters: `$shopSlug.book.tsx` answers a clash with 409 (line 248), and its times come from `slotsFetcher`.
- [ ] **Step 4: Rerun Step 2.** Expected: pass.
- [ ] **Step 5: Inventory, and opt in.**
  - List the API endpoints that answer 409, in `apps/worker` and `apps/workers/booking`. Use the graph or Grep.
  - List the web resource routes that pass the API's status through (`app/lib/worker-proxy.ts`, and routes using `json(await res.json(), { status: res.status })`).
  - List the pages that submit to those routes with a `Form` or a fetcher.
  - Each such page route exports `shouldRevalidate = revalidateAfterConflict`. If it already exports one, compose it.
  - Put the table (endpoint → proxy route → page → ruling) in the PR body. Validation 400s and upstream 5xx keep the new default.
- [ ] **Step 6: Run the web suite and commit.** `cd apps/web && npm test` (all pass). Commit: "fix(web): pages refresh after a conflicting submission under either router".

### Task 5: Ship PR A

- [ ] **Step 1: Run the gates.**
  - `npm run check-types` (root), `npm run lint`, `npm test`, `npm run build`. The build now includes the functions check.
  - `aramid check --staged` on each commit.
- [ ] **Step 2: Compare against main under the Cloudflare runtime.**
  - Run `vite-ab.mjs` (scratchpad method from #182): main's build against this branch's, on a fresh `wrangler pages dev` each.
  - Same 12 pages, same status and titles, 0 hydration errors, client navigation OK.
- [ ] **Step 3: Open the PR.**
  - Push, then `gh pr create`. The body includes the Task 4 inventory table and the Step 0 rulings.
  - Smoke E2E runs by itself.
  - Note the expected deploys: Pages (apps/web changes). API and booking redeploy only if the lockfile changed, and it should not have.
- [ ] **Step 4: Owner's merge OK.** Then `gh pr merge N --merge`, and watch `deploy-web.yml`.
- [ ] **Step 5: Live checks** (GET only):
  - the 6 pages from `hydration-count.mjs` return 200 with 0 errors;
  - `/health` 200 and `/auth/me` 401.
  - A browser test error (Playwright on a live page, `window.dispatchEvent` of an own-error) reaches the Issues email with its route. Find the email through the Gmail search tool.
- [ ] **Step 6: Bake for a day.** No new alerts for 24 hours before PR B merges.

---

## Part B: PR B, the swap (branch `chore/rr7-swap`, cut from main after PR A merges)

### Task 6: The import-rename script

**Files:**
- Create: `apps/web/scripts/rr7-rename-imports.mjs`, `apps/web/app/lib/rr7RenameImports.test.ts`
- Task 10 deletes both.

**Interfaces:**
- Produces `export function renameImports(source: string): { source: string; changed: boolean }`.
- The CLI `node scripts/rr7-rename-imports.mjs <files…>` rewrites the files in place and prints the changed count.

**Rules:**
- `@remix-run/react` → `react-router`.
- `@remix-run/cloudflare`:
  - `json` → `data as json`;
  - `LoaderFunctionArgs`, `ActionFunctionArgs`, `MetaFunction`, `redirect`, `AppLoadContext`, `EntryContext`, `HandleErrorFunction`, `HeadersFunction` and `LinksFunction` → `react-router`.
- `@remix-run/cloudflare-pages` → `@react-router/cloudflare`.
- `@remix-run/server-runtime` → `react-router`.
- The string `"@remix-run/react"` inside `vi.mock(…)`, `vi.importActual(…)` and `typeof import(…)` → `"react-router"`.
- After renaming, merge all value specifiers for one module into one `import {…}`, and all type-only specifiers into one `import type {…}`. Keep inline `type X` specifiers as written.
- Throw on `RemixBrowser` and `RemixServer` (hand-edited in Task 7). Every other `@remix-run/react` name passes through, because `react-router` exports them all.
- Throw on any `@remix-run/cloudflare` name not listed above.

- [ ] **Step 1: Write the fixture tests.** One `it` per rule above, plus:
  - "merges a file importing from both Remix packages into one react-router import";
  - "throws on RemixServer";
  - "throws on an unlisted name";
  - "is idempotent": a second run gives `changed: false`.
- [ ] **Step 2: Run.** `npx vitest run app/lib/rr7RenameImports.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement.** Use a regex over import declarations; the fixtures pin the formats in use. No new dependency.
- [ ] **Step 4: Rerun Step 2.** Expected: all pass.
- [ ] **Step 5: Commit:** "chore(web): a one-off script for the React Router 7 import rename".

### Task 7: The swap

**Files:**
- Modify:
  - root `package.json`, `apps/web/package.json`, `package-lock.json`
  - `apps/web/vite.config.ts`, `apps/web/app/entry.server.tsx`, `apps/web/app/entry.client.tsx`
  - `apps/web/functions/_middleware.ts:2-3` (imports only), `.gitignore`
  - every file Task 6's script changes
- Create: `apps/web/react-router.config.ts`, `apps/web/app/routes.ts`
- Rewrite (tests): `apps/web/app/lib/routerPatchLevel.test.ts`, `apps/web/app/lib/devToolPatchLevel.test.ts`, `apps/web/app/lib/devServer.test.ts`

**Interfaces:** It consumes `webLoadContext` (Task 1) and `renameImports` (Task 6).

- [ ] **Step 1: Rewrite the guards first. They are red on today's tree.**
  - **`routerPatchLevel.test.ts`.** Keep the "catches the shape" and "refuses to pass vacuously" style, with a fixture for each assertion. It checks:
    - every lockfile node named `react-router` is ≥7.18.0, and there is at least one;
    - no `turbo-stream` node is below 3.0.0;
    - there is no `react-router-dom` node;
    - no `@remix-run/*` node exists other than `@remix-run/node-fetch-server`;
    - the root `package.json` has no `react-router`, `react-router-dom` or `@remix-run/router` override;
    - Node resolves `react-router` from `@react-router/cloudflare`'s directory to the root copy.
  - **`devToolPatchLevel.test.ts`:** the Vite floor check resolves Vite from `@react-router/dev`.
  - **`devServer.test.ts`:**
    - the "drives the Vite …" test resolves from `@react-router/dev`;
    - the layout test also expects `react-router: ["node_modules/react-router"]`, and `@react-router/cloudflare` and `@react-router/dev` at the root.
- [ ] **Step 2: Run them on today's tree.** `npx vitest run app/lib/routerPatchLevel.test.ts app/lib/devToolPatchLevel.test.ts`. Expected: FAIL (react-router 6.30.6, turbo-stream 2.x, the Remix nodes).
- [ ] **Step 3: Swap the packages** (Step 0 procedure).
  - Edit the manifests per Global Constraints, then `npm install --no-audit --no-fund`.
  - If `apps/web/node_modules/react-router` exists: run the scratchpad `drop-lock-entries.mjs` on that entry, `rm -rf` the directory, then `npm install` again.
  - Check for stray `esbuild.exe` or `workerd.exe` processes under pp-showcase, then run `npm ci`. Compare the lockfile's sha256 before and after: it must be unchanged.
- [ ] **Step 4: Config.**
  - `react-router.config.ts` per Global Constraints.
  - `app/routes.ts` = `export default flatRoutes() satisfies RouteConfig`.
  - `vite.config.ts`:
    - use `reactRouter()` from `@react-router/dev/vite`, and `cloudflareDevProxy` from `@react-router/dev/vite/cloudflare` with Task 1's `getLoadContext`;
    - keep `ssr: { target: "webworker", noExternal: command === "build" ? true : undefined }`;
    - delete the four v3 flags and the single-fetch comment, and add one line saying why (rxv8 is fixed in react-router ≥7.14.0).
  - Scripts: `"dev": "react-router dev"`, `"build": "react-router build"`. The other scripts are unchanged.
  - Add `.react-router/` to `.gitignore`.
- [ ] **Step 5: Entries and middleware.**
  - `entry.server.tsx`:
    - `RemixServer` becomes `ServerRouter`, keeping `nonce={cspNonce}`, `renderToReadableStream`'s `nonce` and `handleError`;
    - add `export const streamTimeout = 4_950`;
    - abort the render 1 s after `streamTimeout` with an `AbortController` combined with `request.signal`.
  - `entry.client.tsx`: `RemixBrowser` becomes `HydratedRouter` from `react-router/dom`, still inside `startTransition`.
  - Middleware: the import lines only (`@react-router/cloudflare`, and `type ServerBuild` from `react-router`).
- [ ] **Step 6: Run the rename script.** `node apps/web/scripts/rr7-rename-imports.mjs $(git ls-files 'apps/web/app/**/*.ts' 'apps/web/app/**/*.tsx' 'apps/web/functions/**/*.ts')`.
  - Expected: about 140 files changed.
  - `git grep -n "@remix-run/" apps/web` must then show only `@remix-run/node-fetch-server` mentions in tests, if any.
- [ ] **Step 7: Type check.** `cd apps/web && npx tsc`.
  - Fix each error at its source. No `as any` and no new `as unknown as`.
  - Single fetch stops jsonifying loader types (a `Date` stays a `Date`). An error there means the page now receives a different type: change the loader or the consumer, and say which in the commit.
- [ ] **Step 8: Run all the gates, all green.**
  - `npm test` (root);
  - `cd apps/web && npm run build`, which includes the functions check;
  - `npx vitest run app/lib/devServer.test.ts`;
  - the Step 1 guards.
- [ ] **Step 9: Commit:** "feat(web): move the website from Remix 2 to React Router 7". The message lists the dependency swap and the rulings.

### Task 8: Protocol follow-through in unit tests and the dev server test

**Files:**
- Modify: `apps/web/app/lib/devActivityRequiresDeveloper.test.ts:61`, `apps/web/app/lib/devServer.test.ts`, and the comments that describe `?_data=` in:
  - `app/routes/dev.activity.tsx:56`
  - `app/lib/dashboardPagesCheckRole.test.ts:9`
  - `app/lib/apiRoutesAreResourceRoutes.test.ts:9-12`
- Test: `apps/web/app/lib/previewHeaders.test.ts`, created only if the `$shopSlug.tsx` headers need a test (Step 3).

- [ ] **Step 1: Update `pageGet`.** It now builds `https://pivotparlor.com/dev/activity.data?_routes=routes%2Fdev.activity`. The test still asserts the loader's own role check.
- [ ] **Step 2: Add to `devServer.test.ts`:**
  - `it("a page's data request answers in React Router's format")`: `GET /_root.data` → 200, `content-type` starts with `text/x-script`.
  - `it("a plain fetch to a resource route still gets JSON")`: `GET /api/jobs/e2e-job/status` → the content type is `application/json`. The fetch stand-in answers the API with 404, so assert the status the route returns for that today.
  - `it("a form posted without JavaScript renders the page with the action's answer")`:
    - a `POST /login` with an empty urlencoded body, as a document request (no `.data`);
    - expect the status and message `routes/login.tsx` returns for missing fields, and `content-type: text/html`.
- [ ] **Step 3: Check `$shopSlug.tsx`'s `headers` export.** It now also applies to `.data` responses.
  - Read `PREVIEW_HEADERS`. If any name is `Cache-Control` and allows `public` or `s-maxage`, add `previewHeaders.test.ts` asserting it never does, and fix it.
  - Otherwise, record "no caching header" in the PR body.
- [ ] **Step 4: Run.** `npx vitest run app/lib/devServer.test.ts app/lib/devActivityRequiresDeveloper.test.ts`. Expected: pass. Commit: "test(web): data requests, resource routes and no-JS posts under React Router 7".

### Task 9: End-to-end tests

**Files:** Modify `tests/e2e/dashboards.spec.ts` (lines 303, 349, 370 and 402), `tests/e2e/shop-onboarding-routes.ts:28-86` (`installDevShopsCreateMock`), and `tests/e2e/csp-guard.spec.ts:64,110`.

- [ ] **Step 1: `dashboards.spec.ts` reads loader data from the page, not over HTTP.**
  - Add a helper: `async function loaderDataOf(page: Page, routeId: string): Promise<Record<string, unknown>>`, which reads `window.__reactRouterDataRouter.state.loaderData[routeId]`.
  - Each of the four `?_data=` reads becomes `page.goto(url)` (asserting the response status is 200), then `loaderDataOf(page, "routes/<id>")`, with the same assertions on the result.
- [ ] **Step 2: `installDevShopsCreateMock`.** Under React Router 7, the create-shop post goes to `/dev/shops.data` and expects React Router's format.
  - Delete the JSON fallback. Keep "prefer the real network": a real response passes through unchanged.
  - Rule for the whole folder: **no `route.fulfill` may answer a request whose path ends in `.data`**.
  - Check every `page.route` in `tests/e2e`, and list them in the PR body with "document only", "plain fetch" or "fetcher/Form", and the change made.
- [ ] **Step 3: `csp-guard.spec.ts`.** Update the comment ("React Router's inline scripts"), and set the floor in line 110 to the count measured on the PR's staging preview.
- [ ] **Step 4: Sign-in and sign-out.**
  - Make sure a spec signs in through the login form and signs out through the sign-out form, asserting that the `pp_session` cookie appears and then goes.
  - If none does, add `tests/e2e/auth-roundtrip.spec.ts`, using the existing `signIn` helper and staging test accounts from the existing fixtures.
- [ ] **Step 5: Commit.** Run the full tier in the PR (Task 10).

### Task 10: Docs, cleanup, verification, ship PR B

- [ ] **Step 1: Docs and cleanup.**
  - Delete `scripts/rr7-rename-imports.mjs` and its test.
  - Update `CLAUDE.md`:
    - "Remix frontend" becomes "React Router 7 frontend";
    - the route conventions section;
    - the `.js` twin note: Step 0's route table shows fs-routes reads the same files, so keep `clean-app-js.mjs`.
  - Fill in "Step 0 results" in the spec from the rulings above.
- [ ] **Step 2: Compare against main under the Cloudflare runtime** (`vite-ab.mjs`).
  - 12 pages, including both demo shops: same status and titles, 0 hydration errors, client navigation OK.
  - Also: one fetcher flow, one `.data` request, and the 404 shop.
- [ ] **Step 3: Audit.** `npm audit --json` gives 14 findings, no critical, and none in `react-router`, `turbo-stream` or `@remix-run/*`.
  - Run `aramid check --staged`. For the new `@react-router/fs-routes` → `minimatch` row, run `aramid override <id> --reason "..."`. The reason: build-time route-file globbing only; the same GHSA-g3hv already accepted for the lint chain; pre-approved with the design on 2026-11-14.
  - **Any other new row stops the work and goes to the owner.**
- [ ] **Step 4: Open the PR.** `gh pr create --label e2e`. The body carries: the dependency swap, the rulings, the stub table (Task 9), the headers finding (Task 8) and the audit before and after. The full E2E tier must pass.
- [ ] **Step 5: Owner's merge OK.** Merge at a quiet UK hour; the merge deploys Pages, the API and booking.
- [ ] **Step 6: Live checks** (GET only):
  - the pages return 200 with 0 hydration errors, and client navigation works;
  - a `.data` response is `cf-cache-status: DYNAMIC` and carries the security headers;
  - a browser test error reaches the Issues email;
  - `/health` 200, `/auth/me` 401;
  - the API and booking bundles are unchanged.

  Watch the CSP and error inboxes for 24 hours; expect a small burst from open tabs.
- [ ] **Step 7: Rollback**, if anything above fails: Pages rollback to the previous deployment, then `git revert -m 1 <merge>` on `main`.
