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

All Workers Issues alerts on this Cloudflare account go through ONE
notification policy, of type "Real-Time Issue". That type has no filters, so it
covers every Worker with Issues on. It was created for another project and is
named **"BytesFX: Worker error (crm-api, chatbot-api)"**: Pivot Parlor alerts
arrive under that name, emailed to the owner's address. Do not create a second
Real-Time Issue policy for Pivot Parlor; every alert would arrive twice.
Renaming the existing one is the owner's call.

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
3. **After fixing, mark the issue Resolved.** Issues never resolve on their own.
   A new occurrence of a Resolved issue reopens it. Whether a recurrence of an
   issue left Active emails again is not documented, so always resolve, or the
   next outage of the same kind may be silent.

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
# within ~5 minutes: an issue "Uptime check failed: control-deliberate-failure:
# HTTP 404 (want 200)" and an alert email
npx wrangler deploy                            # back to the normal checks
```

Then mark the control issue Resolved. Never put `CONTROL_FAIL` in
`wrangler.toml`: it would alert forever (the guard test refuses it).

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
  assembler, audit) have no Issues. A deploy of one of them without the key
  keeps it off.
- A whole-Cloudflare outage silences the monitor along with the site.
- Staging has Issues off on purpose: E2E runs log errors deliberately, and the
  alert is account-wide.
