# Moving the website from Remix 2 to React Router 7

Design, 2026-11-14. Status: **awaiting the owner's decision**. No code has been written.

## For the owner: the short version

**What it clears (measured, not estimated).** On a scratch copy of today's lockfile with the swap applied, `npm audit` goes from **32 findings to 14**:

| | Today | After |
|---|---|---|
| critical | 1 | 0 |
| high | 16 | 5 |
| moderate | 15 | 8 |
| low | 0 | 1 |

- **Gone:** all three advisories that ship in the website itself:
  - the open redirect in links (GHSA-wrjc);
  - the constructor injection on hydration (GHSA-337j);
  - the data-request denial of service (GHSA-rxv8).
- **Also gone:** the old Remix compiler chain, including the one critical (`tar`), plus `toml`, `cacache`, `glob`, a second Vite 5 and esbuild 0.17.
- **The 14 left** are all developer tools; none ships to visitors:
  - the test pool (5);
  - lint (7);
  - the route-file globber's `minimatch` (1, build only);
  - `tsx`'s esbuild (1, low).

**What it costs.**
- Two pull requests:
  - **PR A** is small. It deploys on its own and changes nothing visitors see.
  - **PR B** is the swap. It touches about 150 files, most of them mechanical renames of imports. It also rewrites about 250 `json()` calls, the mocks in 31 test files and 4 end-to-end files.
- About half a working session for PR A, and one to two sessions for PR B, verification included.
- No new services and no hosting change: the site stays on Cloudflare Pages.
- One dependency swap: four Remix packages are replaced by four React Router packages (listed under Constraints).

**The one real risk.**
- The website's server entry (`functions/_middleware.ts`) gets its Cloudflare settings in a different shape under React Router 7. Wired wrong, every page answers 500.
- Today nothing type-checks that file, because `tsconfig.json` excludes `functions/`.
- The plan closes that gap first (PR A). PR B then has to pass three gates before it merges:
  - the PR's real build on the staging Pages preview, with the full end-to-end run;
  - a local Cloudflare runtime comparison;
  - a type check of `functions/`.
- Rollback is the Pages "roll back to previous deployment" button, which is instant.

**Visible to visitors:** nothing, by design. One side effect: a visitor with a tab open during the deploy may see one error on their next click, until they reload. Every deploy that changes the data format does this. The plan deploys at a quiet hour.

**Recommendation:** go ahead. PR A first, then PR B. React Router 8 and React 19 come later as their own project (Stage 2 below).

---

## Why

- The owner chose this on 2026-11-14 ("Plan the React Router 7 move").
- Remix 2 is in maintenance. Its router line (react-router 6.30.x) and its data encoder (turbo-stream 2.x) carry the only advisories left that reach visitors.
- They are recorded today as accepted risk: six aramid override rows plus the wrjc and rxv8 rows. The fix for all of them is react-router 7.18.0 or later.
- Today's `vite.config.ts` keeps single fetch OFF because of rxv8. React Router 7 has no way to turn single fetch off.
- That is safe now only because the advisory lists react-router 7.14.0 as patched, and 7.18.5 does not depend on turbo-stream at all. **This reverses the "reassess before enabling this feature" comment in `vite.config.ts` deliberately.**

## Goals

1. The website runs on react-router 7.18.5 (or a later 7.x patch) with the Cloudflare Pages adapter, and every page behaves as it does today.
2. Every `@remix-run/*` package that Remix itself installed leaves the lockfile.
   - `@remix-run/node-fetch-server` stays: it is a dependency of `@react-router/dev`, so no guard may forbid the whole `@remix-run/` scope.
3. Re-measured on the real branch, `npm audit` shows no runtime advisory and no critical finding.
4. The guard tests that pin router versions keep doing their job against the new tree.
5. The alerts keep working through the switch: server error emails, browser error emails and CSP reports.

## Non-goals

- No move from Pages to Workers. React Router's docs lean towards Workers with `@cloudflare/vite-plugin`, but that is a separate hosting change.
- No React 19, no React Router 8 and no Vite 7. Those are Stage 2.
- No route typegen (`Route.LoaderArgs`) in PR B. That is the optional PR C.
- No lazy route discovery. The page keeps loading the whole route manifest, as today.
- No redesign, no copy changes and no behaviour changes beyond what the new data protocol forces.

## Anti-goals (these would make it a failure even if it "works")

- Production reads `?_data=` or `.data` responses as the wrong format, so client navigation breaks while the first page load looks fine.
- Alerts go silent: browser errors arrive without a route, server errors are misfiled, or CSP reports flood in because a streamed script lost its nonce.
- `legacy-peer-deps` is committed to `.npmrc`, or the lockfile only installs with flags.
- A guard is weakened to make the tree pass. Each guard is rewritten to check the new tree, and shown red first.
- Anything reaches the production API from a dev server. The `devEnv` swap from #183 stays.

## Constraints

- **Dependencies.**
  - Remove: `@remix-run/cloudflare`, `@remix-run/cloudflare-pages`, `@remix-run/react`, `@remix-run/dev`.
  - Add: `react-router`, `@react-router/cloudflare` (runtime), `@react-router/dev` and `@react-router/fs-routes` (dev).
  - `@react-router/node` and `@remix-run/node-fetch-server` arrive through `@react-router/dev`.
  - Nothing else is added. Approving this design approves exactly this swap.
- **Versions.**
  - React 18.3.1 and Vite 6.4.6 stay. react-router 7.18.5 peers `react >=18`, and `@react-router/dev` 7.18.5 peers vite `^5 || ^6 || ^7 || ^8`.
  - 7.18.5 was published 2026-10-27, the same day as 8.5.1, so the 7.x line is still being patched.
- **Root `package.json` overrides.** The entries `react-router: 6.30.6`, `react-router-dom: 6.30.6` and `@remix-run/router: 1.23.4` must go, or npm forces React Router 7 down to 6.30.6. The `miniflare > undici` override stays.
- **npm 11 lockfile behaviour** (from #182):
  - It ignores new overrides for nodes that are already locked.
  - It prunes a nested entry you delete.
  - The procedure that works: copy npm's own entry to the needed path, then check that a clean `npm ci` reproduces the lockfile byte for byte and that `npm ls` is clean.
- **An existing peer conflict.**
  - The root `wrangler` 4.154.0 has an optional peer `@cloudflare/workers-types ^5`. The repo, `@remix-run/cloudflare` and `@react-router/cloudflare` (7.18.5, and even 8.5.1) all want `^4`.
  - Today's lockfile already carries this unmet optional peer. A fresh resolution refuses it (ERESOLVE), which is why the scratch measurement used `--legacy-peer-deps`.
  - PR B must solve it without committing `legacy-peer-deps` (see Step 0).
- **Repo rules.**
  - Merging needs the owner's OK. Use `gh pr merge N --merge`, never `--auto`. PR B carries the `e2e` label.
  - Never `--no-verify`. Run `aramid check --staged` before each commit, and eslint on changed files.
  - No dashes in user-facing text. No production probe POSTs. Sign-in and sign-out are tested in Playwright against staging, never in the operator's Chrome.
- **Hosting stays as built.**
  - `functions/_middleware.ts` serves every request through Pages Functions (`public/_routes.json` includes `/*`, except `/assets/*`).
  - The middleware owns: the per-request CSP nonce, the security headers, `/client-errors`, `/csp-report`, and the service-binding `fetch` reroute to the API (`app/lib/apiTransport.ts`). All of that stays.

## What was established (and how)

The tag on each fact says how it was established.

**Run in this session:**
- The `npm audit` counts above: on the current tree, and on a scratch copy with the swap applied through `npm install --package-lock-only --legacy-peer-deps`.
- **The scratch tree nested `react-router` under `apps/web/node_modules`,** while `@react-router/cloudflare` and `@react-router/dev` sat at the root. That is the same "stranded package" shape #183 fixed for React, so a real install must be checked for it. (`--legacy-peer-deps` may have caused it; peers are not placed under that flag.)

**Read from the package source or metadata:**
- react-router 7.18.5 exports `data`, `redirect`, `ServerRouter`, `createRoutesStub`, `AppLoadContext`, `ShouldRevalidateFunction`, `HeadersFunction`, `LinksFunction`, `MetaFunction`, `HandleErrorFunction`, `EntryContext` and `ServerBuild`. **It does not export `json` or `defer`.**
- `@react-router/cloudflare` 7.18.5 exports `createPagesFunctionHandler({ build, getLoadContext, mode })`.
  - It calls `getLoadContext({ request, context: { cloudflare: { ...event, cf, ctx: { waitUntil, passThroughOnException }, caches } } })`.
  - **It drops the top-level spread of the Pages event that Remix 2 kept ("Backcompat, remove in v3").** Today's middleware reads `context.env`, `context.waitUntil` and `context.data.cspNonce` from that spread.
- `@react-router/dev` 7.18.5 has `./vite`, `./config`, `./routes` and `./vite/cloudflare` (the dev proxy).
- `HydratedRouter` sets `window.__reactRouterDataRouter` in every build. `__remixRouter` no longer exists.

**Read from the advisories:**
- rxv8: react-router `>=7.0.0 <7.14.0` and turbo-stream `<3.0.0`. It applies only with single fetch.
- wrjc and 337j: react-router `<7.18.0`.

**From the Remix single-fetch guide:**
- Data requests become `GET /path.data`, with `?_routes=` to pick loaders.
- After a 4xx or 5xx action, loaders no longer revalidate by default. `shouldRevalidate` gets `actionStatus`.
- The `headers` export now also applies to data requests.
- The nonce must be passed to both the router and the React renderer.

**Counted in the code** (`apps/web`, excluding build and node_modules):
- **Routes:** 96 route files, 33 of them resource routes (no default export). No compiled `.js` twins are present.
- **json():**
  - 103 calls in 21 resource routes (79 with a status or headers argument);
  - 139 calls in 41 UI routes (49 with an argument);
  - 6 in `app/lib/pos.ts` and `app/lib/worker-proxy.ts`.
- **Imports:**
  - `@remix-run/react` in 106 files (the top names are `Link` 54, `useLoaderData` 39, `useFetcher` 19);
  - `@remix-run/cloudflare` in 95 files;
  - `@remix-run/cloudflare-pages` in 1 file (the middleware);
  - `@remix-run/server-runtime` in 1 file.
- **Typed data hooks** (`useLoaderData<typeof loader>` and similar): 87.
- **Route exports:** one `headers` export (`$shopSlug.tsx`, preview headers) and three `shouldRevalidate` exports (`skipRevalidationForWizardParams` on `$shopSlug.tsx` and `$shopSlug.book.tsx`).
- **Tests:** 31 test files `vi.mock("@remix-run/react")`.
- **Code that knows the old protocol:**
  - `app/lib/serverErrors.ts` (`?_data` decides "data" vs "page");
  - `app/lib/browserErrorReporter.ts` (`__remixRouter`);
  - tests that build `?_data=` requests: `serverErrors.test.ts`, `devActivityRequiresDeveloper.test.ts` and `dashboardPagesCheckRole.test.ts`;
  - E2E: `dashboards.spec.ts` (4 raw `?_data=` reads, parsed as JSON), and JSON `route.fulfill` fallbacks for fetcher posts in `shop-onboarding-routes.ts`, `stripe-payment.spec.ts` and `site-generation.spec.ts`.
- **The browser-error endpoint accepts `route: "unknown"`**, so alerts would not go silent if the route lookup failed. They would just lose the route name.
- **CI facts:**
  - `deploy-web.yml` runs on `apps/web/**`, `packages/{types,utils}/**`, `package.json` and `package-lock.json`.
  - `deploy-worker.yml` also runs on `package-lock.json`, so PR B redeploys the API and booking workers, unchanged.
  - `e2e.yml` builds the PR's website and deploys it to the staging Pages preview before the tests. The real Pages adapter is therefore exercised before merge.

## The design: what moves, in what order

### Step 0: a measuring spike (throwaway, never merged)

This is done on a scratch branch to settle four facts before PR B is planned in detail. Each one changes how PR B is written.

1. **Install shape.**
   - Do the real swap with `npm install`, not lock-only, and find a resolution of the workers-types conflict that a clean `npm ci` reproduces.
   - Candidates, in order:
     - (a) a root `overrides` entry that pins `@cloudflare/workers-types` to the repo's v4 so wrangler's optional peer edge accepts it;
     - (b) the #182 hand-copy procedure;
     - (c) bump the repo to workers-types v5, but only if `@react-router/cloudflare`'s required `^4` peer then still resolves.
   - Check that `react-router` and every `@react-router/*` package sit at the root `node_modules`.
2. **How resource routes answer.** For one resource route, compare `Response.json(x, init)` with `data(x, init)`:
   - what a plain `fetch` GET receives;
   - what `useFetcher().load` and `fetcher.submit` receive in `fetcher.data`.

   This decides the json() strategy for resource routes (see PR B, item 4).
3. **Route ids are unchanged.** `flatRoutes()` from `@react-router/fs-routes` must produce exactly today's 96 route ids and paths. Compare the build manifests. A difference would change URLs and break `PAGE_ROUTES`.
4. **Config keys exist in 7.18.5:** `routeDiscovery: { mode: "initial" }` and `ssr: true` in `react-router.config.ts`.

Output: a short note added to this design (the "Step 0 results" section), and a ruling for each.

### PR A: preparation (deploys alone; nothing visible changes)

Every change here works under today's Remix 2 and under React Router 7, so it ships and bakes first.

1. **Type-check `functions/`.**
   - Add a `tsconfig.functions.json` (or a project reference) that type-checks `functions/_middleware.ts` against `@cloudflare/workers-types` and the Pages `EventContext`.
   - Run it in `npm run check-types`.
   - Prove it red first: change one property name on a scratch line and watch it fail.
2. **Server-error classification reads both protocols.** `serverErrors.ts` classifies a request as "data" when it has `?_data=` **or** its pathname ends in `.data`. Add tests for both forms.
3. **The browser-error route lookup reads both globals:** `window.__reactRouterDataRouter`, falling back to `window.__remixRouter`. Add tests for both, and for neither (which gives `"unknown"`).
4. **Resource routes stop using `json()` where the answer does not depend on Step 0.** A resource route whose only callers are raw `fetch` calls (job-status polling, external callers) moves to `Response.json(x, init)`, which behaves the same today. Routes called by fetchers wait for Step 0's answer.
   - *Builder:* classify the 33 resource routes by caller first and record the table in the PR.
   - A difference to note: `json()` sets `application/json; charset=utf-8`, while `Response.json` sets `application/json`. No caller is known to compare the header; check.
5. **One load-context type.** Create `app/lib/loadContext.ts` with the context type `{ env, waitUntil, cspNonce }` that the middleware, the dev proxy and `entry.server.tsx` all use. PR B then only changes which module it augments.

Deploy: Pages only, plus the API and booking workers if the lockfile changes (it should not). Then verify live: pages return 200 with 0 hydration errors, and a browser test error reaches the Issues email with its route name.

### PR B: the swap (one release)

Single fetch cannot ship on Remix 2 (rxv8), and React Router 7 cannot run without it. So the protocol change and the package swap land together, in one PR and one deploy.

1. **Packages.**
   - Make the dependency swap under Constraints, and remove the three root overrides.
   - Use Step 0's resolution for the workers-types conflict.
   - Check that `npm ci` reproduces the lockfile and `npm ls` is clean.
2. **Build and dev config.**
   - Add `react-router.config.ts`: `ssr: true` and `routeDiscovery: { mode: "initial" }`, and no v8 future flags.
   - Add `app/routes.ts` = `flatRoutes()`.
   - In `vite.config.ts`:
     - replace the `remix()` plugin with `reactRouter()`;
     - replace the hand-`require`d dev proxy with `cloudflareDevProxy` from `@react-router/dev/vite/cloudflare`, keeping the same `getLoadContext` shape and the `devEnv` production-API swap;
     - keep `ssr.noExternal` for the build only;
     - delete the four v3 future flags and the single-fetch comment, recording why in the commit.
   - Scripts: `react-router dev` and `react-router build`. The existing pre/post scripts stay; check that `clean-app-js.mjs` still applies to fs-routes.
   - Add `.react-router/` to `.gitignore`. It is generated even without typegen use.
3. **Entries and the root.**
   - `entry.server.tsx`: `RemixServer` becomes `ServerRouter`. Keep `nonce` on both the router and `renderToReadableStream`, and keep `handleError`.
     - Add `export const streamTimeout`, at 4950, the default.
     - React's abort runs after `streamTimeout`, through the existing `signal` plus a timer above `streamTimeout`.
   - `entry.client.tsx`: `RemixBrowser` becomes `HydratedRouter` (from `react-router/dom`), still inside `startTransition`.
   - `root.tsx`: imports only.
   - `functions/_middleware.ts`:
     - Import `createPagesFunctionHandler` from `@react-router/cloudflare` and `ServerBuild` from `react-router`.
     - `getLoadContext({ context })` returns `{ env: context.cloudflare.env, waitUntil: (p) => context.cloudflare.ctx.waitUntil(p), cspNonce: context.cloudflare.data.cspNonce }`.
     - **This is the line that takes production down if it is wrong. PR A's `functions/` type check must pass on it.**
4. **Imports and `json()`.**
   - A local, committed script renames imports using the official table: `@remix-run/react` and the shared `@remix-run/cloudflare` names go to `react-router`, and the Pages adapter goes to `@react-router/cloudflare`. The same script rewrites the `vi.mock("@remix-run/react")` strings in the 31 test files.
     - *My call:* not `npx codemod`, which would run third-party code from a registry to do a table lookup.
   - UI routes: `json(x)` becomes `x`, and `json(x, init)` becomes `data(x, init)`.
   - Resource routes: follow Step 0's ruling.
     - The default is `Response.json(x, init)`, because some callers are plain `fetch`.
     - A local `json()` shim is allowed only if Step 0 shows it gives the same bytes for every caller kind.
   - `pos.ts` and `worker-proxy.ts` follow whichever kind of route calls them.
   - **Typing:** with single fetch, `useLoaderData<typeof loader>` stops "jsonifying" types, so a `Date` stays a `Date`. Fix each new `tsc` error at its source; do not cast it away. Each error is a real change in what the page receives.
   - Add the augmentation `declare module "react-router" { interface AppLoadContext ... }`, plus the temporary `LoaderFunctionArgs` / `ActionFunctionArgs` context augmentation from the official guide, built on `app/lib/loadContext.ts`.
5. **Behaviour the new protocol changes, route by route.** Inventory these in the PR, with a ruling each:
   - **Revalidation after a failed action.**
     - List every UI action that returns 4xx/5xx.
     - Where the page's own data can have changed behind the failure, that route's `shouldRevalidate` returns `true` for `actionStatus >= 400`. The likely case is the booking clash (409), where the shown times may be stale.
     - Validation 400s keep the new default (no reload).
     - `skipRevalidationForWizardParams` returns `defaultShouldRevalidate` for form submissions, so it inherits the new default. Rule on whether the booking page needs the opt-in.
   - **`$shopSlug.tsx`'s `headers` export now also applies to `.data` responses.** These carry every matched loader's data, the root's session data included. Confirm it can never add public caching to them.
   - **Sign-in and sign-out.** The session cookie is now set or cleared by an action redirect inside a `.data` response. Cover both in Playwright on staging.
   - **Developer `?shopId=` and staff-view `?staffId=` navigation:** check through client navigation, not only on first load.
6. **Guards and tests.**
   - **`routerPatchLevel.test.ts`, rewritten.** Every `react-router` node in the lockfile is ≥7.18.0. No `turbo-stream` below 3.0.0 exists anywhere. No `react-router-dom` remains, and no `@remix-run/*` remains other than `node-fetch-server`.
   - **`devToolPatchLevel.test.ts`:** Vite resolved from `@react-router/dev`, not `@remix-run/dev`.
   - **`devServer.test.ts`:**
     - It drives `react-router dev`'s Vite.
     - The layout check adds `react-router` and `@react-router/*` at the root (the stranded-package trap above).
     - The `.data` endpoint of one page answers.
   - **Tests that build `?_data=` requests** move to `.data` / `.data?_routes=<id>` forms. They keep asserting what they assert today: a data request for one route runs that route's own role check.
   - **E2E:**
     - `dashboards.spec.ts` stops reading loader data over HTTP. It asserts on rendered content, or on `window.__reactRouterDataRouter.state.loaderData` in the page.
     - The JSON `route.fulfill` fallbacks for fetcher posts are removed or changed to `route.continue()`. **No stub may answer a `.data` request with JSON.**
     - `csp-guard.spec.ts` keeps its nonce count, re-measured.
7. **Docs.** Update `CLAUDE.md` ("Remix frontend", the route conventions, the `.js` twin gotcha if fs-routes differs) and the memory notes. Remove the single-fetch reasoning from `vite.config.ts`.

### PR C (optional, later): typed routes

Adopt `Route.LoaderArgs` typegen file by file and drop the temporary `LoaderFunctionArgs` augmentation. No behaviour change. Worth doing only if the owner wants the type safety.

### Stage 2 (a separate project, planned later)

React Router 8 needs React ≥19.2.7 and Vite 7 or 8. That brings React 19 (new hydration and ref semantics, and dependency peers across Radix and lucide), so it is its own design and its own decision. It would also retire `@react-router/fs-routes`' minimatch 9 row if 8.x moves to a fixed minimatch. That is unverified.

## How each step is tested

**Every PR:**
- the full web suite (749 tests today), `tsc` for the app and `functions/`, eslint, and `aramid check --staged`;
- the root `npm test` across all workspaces.

**Step 0:** its own four measurements, recorded.

**PR A:**
- unit tests for both protocols in `serverErrors` and `browserErrorReporter`, shown red first;
- the `functions/` type check, shown red with a planted error;
- after deploy: pages return 200, 0 hydration errors, and a browser test error arrives in the Issues email with its route.

**PR B, before merge:**
1. **Route-manifest equality:** the same 96 route ids and paths as today's build.
2. **Local Cloudflare runtime A/B** (the #182 `vite-ab.mjs` method, `wrangler pages dev`, fresh per build). Today's build against PR B's:
   - 12 pages, including both demo shops, with the same status and titles;
   - 0 hydration errors;
   - client navigation works;
   - a fetcher flow, a `.data` request, and a 404 shop.

   **This is the gate for the middleware's load context**, together with the `functions/` type check.
3. **The full E2E run** (`e2e` label). The PR's build on the staging Pages preview with the staging worker, including sign-in and sign-out.
4. **`npm audit` re-measured** on the branch: no runtime advisory, no critical. The success measure is npm audit, not the aramid ledger, because a ledger row has already been seen to stay "overridden" after its advisory went away (f5ec8cac).
5. **The dev server:** `devServer.test.ts`, plus one manual `npm run dev` page load.

**PR B, after deploy** (read-only, no probe POSTs):
- the 12 pages return 200 with 0 hydration errors, and client navigation works;
- a `.data` response is `cf-cache-status: DYNAMIC` and carries the security headers;
- no CSP reports and no server-error emails beyond the expected open-tab burst;
- a browser test error reaches the Issues email;
- `/health` 200, `/auth/me` 401;
- the API and booking workers redeployed with unchanged bundles.

## Hazards (summary)

| Hazard | Caught by |
|---|---|
| The middleware reads the old top-level Pages event fields, so every page answers 500 | PR A's `functions/` type check; the PR B A/B; the E2E on the staging preview |
| Root overrides force react-router to 6.30.6 | install failure; the `routerPatchLevel` rewrite |
| `react-router` stranded under `apps/web` | the `devServer.test` layout check |
| workers-types v4/v5 peer conflict | Step 0, then `npm ci` reproducibility |
| E2E stubs answer `.data` with JSON | the "no stub answers `.data` with JSON" rule; E2E red |
| Loaders stop refreshing after a failed action | the route-by-route inventory (PR B, item 5) |
| `headers` export applies to `.data` | an explicit check (PR B, item 5) |
| Alerts misfile or lose their route | PR A's dual reads, then the post-deploy alert test |
| Streamed data scripts without a nonce | `csp-guard.spec.ts`; the CSP report inbox |
| Open tabs during the deploy | quiet-hour deploy; expected one-off browser-error burst |

## Rollback

- **PR A:** a Pages rollback, or a revert. It is behaviour-neutral.
- **PR B:** first, a Pages rollback to the previous deployment (instant). The workers are unaffected by the website rollback. Then revert the merge on `main`, so the next deploy does not bring it back.
- Rolling back shows the same open-tab effect, in reverse.

## Decided here, and left to the builder

**Decided (my calls, open to the owner's veto):**
- the two-PR shape;
- a quiet-hour deploy;
- `routeDiscovery: initial`;
- no v8 future flags;
- a local rename script, not the third-party codemod;
- `Response.json` as the default for resource routes;
- the npm-audit success measure;
- typegen deferred to PR C.

**Left to the builder:**
- the exact Step 0 resolution;
- the resource-route caller table;
- the per-route revalidation rulings;
- how `dashboards.spec.ts` asserts;
- whether `tsconfig.functions.json` is a reference or a separate run.

## Step 0 results

*(To be filled in by the spike.)*
