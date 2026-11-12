# Production alerting

What tells the owner that production is broken, where the alert goes, and what
to do when one arrives. Set up 2026-11-11.

## What is watched

| Signal | Covers | Source |
| --- | --- | --- |
| Workers Issues on `pivot-parlor-api` and `pivot-parlor-booking` (production only) | Uncaught exceptions, 5xx replies, failed cron and queue runs, and anything logged with `console.error` | `[observability.issues]` in each `wrangler.toml` |
| Workers Issues on the AI workers `pivot-parlor-research`, `pivot-parlor-text`, `pivot-parlor-images`, `pivot-parlor-assembler` (the `builder` directory) and `pivot-parlor-chatbot` | A site generation job that fails, an AI model or image call that fails (even when the job falls back and finishes), failed queue runs, and shop chat errors | `[observability.issues]` in each `wrangler.toml` |
| CSP violation reports, through Workers Issues on `pivot-parlor-api` | The site's Content-Security-Policy blocking something on a real visitor's page (a script, style, connection, frame, image, font or form), which usually means a feature broke for that visitor | `POST /csp-report` (`apps/worker/src/routes/csp-report.ts`); the policy asks for reports in `apps/web/app/lib/securityHeaders.ts` |
| Website server errors, through Workers Issues on `pivot-parlor-api` | An unexpected error in the website's server code: loading a page or its data, a form post, or the server render. The visitor saw an error page or a failed action | `apps/web/app/lib/serverErrors.ts` reports over the `WEB_ERRORS` service binding to `apps/worker/src/web-errors.ts` |
| Uptime monitor `pivot-parlor-uptime`, every 5 minutes | The public site answers, the API answers as itself, and a booking lookup reaches the booking worker and the database | `apps/workers/uptime` |
| Pages deployment alert for `pivot-parlor-web` | A production Pages deployment that fails on Cloudflare's side | Cloudflare notification policy "Pivot Parlor: Pages production deploy failed" |

The uptime checks (`apps/workers/uptime/src/checks.ts`), all read-only GETs:

| Check | Passes when |
| --- | --- |
| `site-home` | `https://pivotparlor.com/` is 200 HTML **with our Content-Security-Policy header** (proof the app answered, not a static fallback) |
| `site-login` | `/login` is 200 HTML |
| `site-shop` | the demo shop page (`DEMO_SHOP_SLUG`) is 200 HTML: server-rendered from the API and D1 |
| `api-auth` | `https://api.pivotparlor.com/auth/me` refuses with a JSON 401 |
| `booking-slots` | demo shop by slug, then its services, then tomorrow's slots for the first service: API, BOOKING service binding, booking worker, D1 and KV. An empty slot list (a closed day) passes |

A check is tried 3 times (10 s timeout, 5 s apart) before it counts as failing,
so one dropped request never alerts. Redirects are not followed: a page that
starts redirecting fails.

## Where alerts go

Workers Issues only groups errors. It sends nothing on its own: an issue is
emailed only when an **automation** sends it to a notification policy. Pivot
Parlor has:

- the notification policy **"Pivot Parlor: Worker issue"** (type Real-Time
  Issue), which emails the owner's address;
- two automations for each of `pivot-parlor-api`, `pivot-parlor-booking`,
  `pivot-parlor-uptime` and the five AI workers (16 in all), both sending to
  that policy:
  - `Pivot Parlor <worker>: new issue` fires once, on an issue's first
    occurrence;
  - `Pivot Parlor <worker>: returning issue` fires when an issue occurs
    again after at least an hour with no occurrences.

What that means in practice:

- One email per new kind of failure, not one per failure. An outage that keeps
  failing every 5 minutes sends one email, then nothing more until it has been
  quiet for an hour and comes back.
- Issues groups errors with their variable parts masked. The uptime error
  `Uptime check failed: site-login: HTTP 503 (want 200)` is grouped as
  `Uptime check failed: <token>: HTTP 503 (want 200)`, so the same reason on
  different checks is one issue. Each occurrence still carries the full
  message, check name included.
- A failure that matches an issue seen before (Active or Resolved) is not new,
  so it can alert only through the returning-issue rule. For example, a real
  `HTTP 404 (want 200)` on a site page joins the issue opened by the 2026-11-11
  firing-control runs, which used that reason. The control now fails with a
  reason of its own (see Deploying the monitor).
- Both rules proven on 2026-11-11, emails checked in the owner's inbox:
  - an occurrence-threshold automation sent the control issue to this policy,
    and the email arrived 30 seconds after the failing run;
  - the returning-issue rule fired on the same issue, while it was Resolved,
    64 minutes after its previous occurrence. The issue went back to Active and
    the email arrived 33 seconds after the failing run.
- The AI workers' path proven on 2026-11-12, after their Issues deploy: one
  malformed message on `site-text-queue` opened the issue
  `[pivot-parlor-text] invalid message {"probe":"<string>"}`, and the
  new-issue email arrived 28 seconds later (see Deploying the AI workers).

Issues also opens **security** issues on its own, for requests that look like
a vulnerability scan. The first one arrived on 2026-11-11: "Potential
vulnerability scan · source-control · low risk", a scanner asking
`api.pivotparlor.com` for `/.svn/wc.db`. The API answered 404, and the
occurrence reads "No matching outbound fetch was observed". Kinds are coarse:
a later `/.git/config` probe joined the same issue.

Scanner issues email like any other issue, and **marking one Ignored does not
stop that**. Measured on 2026-11-11: the source-control issue was Ignored, a
`/.git/config` probe arrived three hours later, and the returning-issue rule
still emailed. So scanner paths are now blocked before they reach the API, by
the Cloudflare firewall rule **"Pivot Parlor: block scanner paths on the API
(hidden files, .php, WordPress)"** (zone `pivotparlor.com`, Security, WAF,
custom rules). On `api.pivotparlor.com` it blocks:

- any path containing `/.` (hidden files such as `/.git/config` or
  `/backend/.env`), except `/.well-known/`;
- any path ending in `.php`;
- WordPress paths: starting with `/wp-`, or containing `/wp-admin`,
  `/wp-content/` or `/wp-includes/`.

No API route has such a path: routes start with `/api`, `/auth`, `/assets`,
`/staff`, `/contact` or `/health`, and shop slugs are lowercase words and a
number. A blocked request
gets Cloudflare's 403 page and never runs the worker, so it raises no issue.
Verified 2026-11-11: six scanner paths answered 403 from Cloudflare and did not
appear in the API's logs, while `/auth/me` still answered its JSON 401 and the
demo shop's site and services their JSON 200s. The Free plan allows 5 custom
rules, and this is the only one.

The automations are not in this repository. They live in the account and are
read and changed through the Cloudflare API
(`/accounts/<account>/workers/observability/issues/automations`, at most 50 per
account). A worker that gets Issues later needs its own pair.

The policy **"BytesFX: Worker error (crm-api, chatbot-api)"** belongs to
another project. It is also a Real-Time Issue policy: leave it alone. A
Real-Time Issue policy has no filters; the automations that point at it decide
which workers it hears about.

The Pages deployment alert is its own policy and emails the same address.

GitHub's failed-workflow emails go to the GitHub account that triggered the run,
not necessarily to the owner, so they are not part of this alerting.

## When an alert arrives

1. Open the issue: Cloudflare dashboard, Workers & Pages, the worker named in
   the email, **Issues**. Occurrences keep their details for 7 days.
2. For the uptime monitor, the message names the check and the reason, for
   example `Uptime check failed: booking-slots: slots: HTTP 500 (want 200)`.
   - `site-*` failing alone: the Pages app (`pivot-parlor-web`). Check its
     latest deployment; roll back in the Pages dashboard if a deploy caused it.
   - `api-auth` failing: the API worker is down or answering as something else.
     Check `pivot-parlor-api` Issues and its latest deployment.
   - `booking-slots` failing with `api-auth` passing: the booking worker or the
     BOOKING binding (`pivot-parlor-booking` Issues), or the demo shop's data.
   - Everything failing at once: also check https://www.cloudflarestatus.com.
   - An AI worker (research, text, images, assembler): the message starts
     with the job id in brackets.
     - `Job failed`, `could not produce a valid spec` or `outer failure`:
       that shop's site generation failed. Read the error, then regenerate
       the site from the developer dashboard once the cause is fixed.
     - `model call failed`, `HERO FAILED`, or an image call's
       `network error`, `HTTP <status>`, `invalid JSON` or
       `no image in response`: the AI provider refused or failed. The job
       carries on (text falls back to another model, then to the research
       copy; images leaves that picture out, and the site keeps the one it
       had), so the site may be thinner than it should be. Check the
       provider's status and the model chosen on AI Deploy.
   - The chatbot (`[chatbot] public /chat error`): a shop's chat answered
     with an error. Read the occurrence for the shop and the cause.
   - A CSP block on `pivot-parlor-api` (`[csp] blocked a script`, `a style`,
     `a connection`, `a frame`, `an image`, `a font`, `a form submission` or
     `something else`): a visitor's browser refused something the page asked
     for. Each kind is its own issue. The occurrence gives the rule
     (`directive`), what was blocked (`blocked`, without its query string),
     the page, and the script and line that asked for it.
     - Something of ours was blocked (a new script host, an API origin, an
       embed): the policy in `apps/web/app/lib/securityHeaders.ts` is missing
       it. Add it there (and to `public/_headers`, which its test compares),
       then deploy the site.
     - Something foreign was blocked on our page (an unknown script host):
       the policy did its job. Find out how it got onto the page before
       resolving the issue.
     - Reports caused by browser extensions, reports about other sites'
       pages, and reports from staging or preview pages are dropped before
       logging, so they never alert.
   - A website server error on `pivot-parlor-api`
     (`[web] <error type> in <where> <method> <route>`): the website's server
     code failed. `where` says what was running: `page` (loading a page),
     `data` (a page's data, fetched while browsing), `action` (a form post or
     button), `render` (drawing the page) or `middleware` (the website's own
     request handling). The route has its values replaced by names
     (`/book/:shopSlug`). The occurrence gives the error's message
     (`detail`), with emails, ids and tokens masked, and the top stack lines
     (`frames`).
     - Find the route file in `apps/web/app/routes/`, reproduce on staging,
       fix and deploy the site.
     - `AlertTestError` is the dashboard's test button (see Website server
       errors): resolve it.
   - A security issue ("Potential vulnerability scan ..."): open its
     occurrence and read the request and the answer.
     - The answer was a 2xx, or the occurrence shows an outbound fetch: treat
       it as an incident.
     - The worker turned it away (a 4xx, and no matching outbound fetch): it is
       a scan the firewall rule does not cover yet. Add its path pattern to the
       rule (see Where alerts go), check that the path now gets Cloudflare's
       403 while `/auth/me` still answers JSON 401, then mark the issue
       Resolved. Ignored does not stop its emails.
3. **After fixing, mark the issue Resolved**, so the Issues list shows only
   what is still open. Issues never resolve on their own. Resolving does not
   make the issue new again: if the same failure comes back, plan on it
   alerting through the returning-issue rule (after an hour of quiet), not the
   new-issue rule. While an issue is still failing, no further emails come, so
   check the worker's Issues page rather than waiting for one.

## Deploying the monitor

The monitor is deployed by hand, like the other background workers (CI does not
deploy it), with the owner's go-ahead:

```bash
cd apps/workers/uptime
npx wrangler deploy
```

**Firing control** (after the first deploy, or to re-prove the alert path):

```bash
npx wrangler deploy --var CONTROL_FAIL:true   # adds a check built to fail
# within ~5 minutes: an occurrence of the issue
# "Uptime check failed: <token>: deliberate test failure, not an outage"
npx wrangler deploy                            # back to the normal checks
```

The control asks production for nothing and fails with a reason no real check
produces, so it always lands in its own issue and never silences a real
outage's email. Which rule sends its email:

- The first control run with this reason opens a new issue, so the new-issue
  rule emails.
- Later runs email through the returning-issue rule, as long as the control
  has been quiet for more than an hour.
- To re-test within the hour, add a temporary automation for
  `pivot-parlor-uptime`: trigger "occurrence threshold", threshold = the
  issue's current occurrence count + 1, policy "Pivot Parlor: Worker issue".
  The next control failure crosses it and sends the email. Delete the
  temporary automation afterwards.

Then redeploy without the control and mark the control issue Resolved. Never
put `CONTROL_FAIL` in `wrangler.toml`: it would fail every run (the guard test
refuses it).

To change the demo shop, edit `DEMO_SHOP_SLUG` in
`apps/workers/uptime/wrangler.toml`. The shop needs a public page and at least
one service. The pre-launch purge (`docs/PURGE-daf88508.sql`) keeps the FerdyM
demo shop, its services and staff, so the default survives it.

## CSP violation reports

Every page sent with the site's standard policy (all but a route that sets its
own, such as the activity export) asks the browser to report CSP violations to
its own deployment's API (`report-to`, with `report-uri` for older browsers):
production pages to `https://api.pivotparlor.com/csp-report`, staging pages to
the staging API, where Issues is off. So the E2E collector's deliberate
violation, which runs on every PR, never emails.

The endpoint drops, without logging: reports past 20 a minute from one IP (per
Cloudflare location, the `CSP_REPORT_LIMITER` binding, answered 429), bodies
over 16 KB (413), anything that is not JSON (400), reports caused by browser
extensions, and reports about pages that are not the live site. It writes
nothing to the database or the audit trail.

**Firing control** (to re-prove the path): send one hand-made report with a
blocked URL that names the test in its path, for example:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.pivotparlor.com/csp-report \
  -H "Content-Type: application/csp-report" \
  -d '{"csp-report":{"document-uri":"https://pivotparlor.com/","effective-directive":"script-src-elem","blocked-uri":"https://alert-path-check.invalid/probe.js","disposition":"enforce"}}'
```

It answers 204, and `pivot-parlor-api` opens (or, after an hour of quiet,
reopens) the issue `[csp] blocked a script ...`. Mark it Resolved afterwards.

## Website server errors

Pages Functions have no Workers Issues, so the website hands each server error
to the API. Remix's `handleError` (`apps/web/app/entry.server.tsx`) catches
errors in loaders, actions and the render. `functions/_middleware.ts` catches
errors in its own code. Both call `reportServerError`
(`apps/web/app/lib/serverErrors.ts`), which keeps the local log line and sends
one report over the `WEB_ERRORS` service binding to the API's `WebErrors`
entrypoint (`apps/worker/src/web-errors.ts`). That entrypoint is reachable
only over the binding, not from the internet. Its `console.error` is what
Issues turns into the email, through the API's existing automations.

What a report carries:

- what was running (`where`) and the method;
- the route with every value replaced by its name;
- the error type and its message, with emails, ids, tokens and long numbers
  masked (again on the API side);
- the top five stack lines, without file paths.

Never the query string, headers, cookies, form contents or who the visitor
was. Not reported at all:

- a visitor who left before the page finished;
- a deliberate response thrown by a route (a redirect, 404 or 403);
- Remix's own not-found and method-not-allowed answers.

The API logs at most 30 reports a minute for one route and kind (per
Cloudflare location, the `WEB_ERROR_LIMITER` binding) and drops the rest.

Staging's website binds to the staging API, where Issues is off:
`scripts/ci-set-web-staging-vars.mjs` moves every API binding (`API` and
`WEB_ERRORS`) to `pivot-parlor-api-staging`, and
`apps/workers/uptime/test/alerting-config.test.ts` fails if one stays on
production. So E2E failures on staging never email.

**Firing control** (to re-prove the path): sign in as a developer, open the
developer dashboard's Overview, and press **Send a test alert** under Alert
check. The website raises one `AlertTestError` from
`POST /api/dev/alert-test` and says "Test error raised". `pivot-parlor-api`
opens (or, after an hour of quiet, reopens) the issue
`[web] AlertTestError in action POST /api/dev/alert-test ...`. The issue title
may mask parts of the route; the occurrence keeps it in full. Nothing else
changes. Mark the issue Resolved afterwards.

On staging, `tests/e2e/alert-test.spec.ts` presses the button on every FULL
E2E run. Staging's Issues is off, so it emails nobody. Its report shows in the
staging API's Workers Logs as the same `[web] AlertTestError ...` event.

## Deploying the AI workers

Each AI worker is also deployed by hand, from its own directory, with the
owner's go-ahead:

```bash
cd apps/workers/<research|text|images|builder|chatbot>
npx wrangler deploy
```

The deploy output must not contain
`Unexpected fields found in observability field: "issues"`. If it does, that
Wrangler is too old (see below) and the deploy has just turned Issues off.
Then read the setting back: the worker's script settings
(`/accounts/<account>/workers/scripts/<name>/script-settings`) must show
`observability.issues.enabled: true`.

**Firing control** (to re-prove the AI workers' alert path): send one message
with no `jobId` to `site-text-queue` through the Cloudflare API:
`POST /accounts/<account>/queues/<site-text-queue id>/messages` with the body
`{"content_type": "json", "body": {"probe": "alert-path check"}}` (the queue id
is in the `GET /accounts/<account>/queues` listing). The text worker logs
`[pivot-parlor-text] invalid message`, acknowledges the message and stops: it
reads and writes nothing and makes no AI call. The first such probe opens a new
issue and the new-issue rule emails; a later one emails through the
returning-issue rule if the probe issue has been quiet for over an hour. Mark
the issue Resolved afterwards.

## Wrangler version

Issues needs Wrangler 4.134.0 or later. An older Wrangler only warns
`Unexpected fields found in observability field: "issues"` and deploys anyway,
which turns Issues OFF. The deploy tool is pinned as a root devDependency (CI
runs `npx wrangler deploy` from the repo root). `@cloudflare/vitest-pool-workers`
pins its own older Wrangler for the test runtime, so there are two copies on
purpose. `apps/workers/uptime/test/alerting-config.test.ts` fails the suite if
the Issues keys or the Wrangler floor drift, including a nested older Wrangler
under one of the AI workers.

## Not covered

- Errors in visitors' browsers (the site's JavaScript after the page has
  loaded) are not reported. Only the website's server code is (see Website
  server errors).
- A failure inside Remix's Pages adapter itself, outside any route, comes back
  as a bare `Internal Error` 500 with no log line. Only the uptime checks see
  it.
- `pivot-parlor-audit` has no Issues on purpose: nothing sends to its queue
  (`site-audit-queue` had no producers, checked 2026-11-12), so there is
  nothing to alert on. Retiring it is an open owner decision. If it is ever
  brought back, its own `package-lock.json` pins Wrangler 4.76.0, which would
  drop the Issues key: raise it first, then add the key and a pair of
  automations.
- A whole-Cloudflare outage silences the monitor along with the site.
- Staging has Issues off on purpose: E2E runs log errors deliberately, and the
  alert is account-wide.
