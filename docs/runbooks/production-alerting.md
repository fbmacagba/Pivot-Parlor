# Production alerting

What tells the owner that production is broken, where the alert goes, and what
to do when one arrives. Set up 2026-11-11.

## What is watched

| Signal | Covers | Source |
| --- | --- | --- |
| Workers Issues on `pivot-parlor-api` and `pivot-parlor-booking` (production only) | Uncaught exceptions, 5xx replies, failed cron and queue runs, and anything logged with `console.error` | `[observability.issues]` in each `wrangler.toml` |
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
- two automations for each of `pivot-parlor-api`, `pivot-parlor-booking` and
  `pivot-parlor-uptime`, both sending to that policy:
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

## Wrangler version

Issues needs Wrangler 4.134.0 or later. An older Wrangler only warns
`Unexpected fields found in observability field: "issues"` and deploys anyway,
which turns Issues OFF. The deploy tool is pinned as a root devDependency (CI
runs `npx wrangler deploy` from the repo root). `@cloudflare/vitest-pool-workers`
pins its own older Wrangler for the test runtime, so there are two copies on
purpose. `apps/workers/uptime/test/alerting-config.test.ts` fails the suite if
the Issues keys or the Wrangler floor drift.

## Not covered

- Runtime errors inside the Pages app (Remix SSR) are seen only through the
  uptime checks: Workers Issues does not cover Pages Functions.
- The AI and background workers (chatbot, research, text, images, builder,
  assembler, audit) have no Issues. Turning it on needs the key in that
  worker's `wrangler.toml` and a pair of automations (see Where alerts go).
- A whole-Cloudflare outage silences the monitor along with the site.
- Staging has Issues off on purpose: E2E runs log errors deliberately, and the
  alert is account-wide.
