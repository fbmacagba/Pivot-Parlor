# Stripe live mode: the switch from the sandbox

Production's workers run on a Stripe **sandbox** today (named "Ferdinand",
under the main Stripe account). Nothing real is charged. Do this before the
first real shop takes a payment. The owner does every step that needs the
Stripe dashboard or a secret value; nobody pastes a key into a chat or a file.

Staging stays on the sandbox key for good. Never put a live key on
`--env staging`.

## What the code expects

| Worker | Endpoint URL | Events | Secrets |
|---|---|---|---|
| `pivot-parlor-booking` | `https://pivot-parlor-booking.bmorris0565.workers.dev/webhooks/stripe` | `payment_intent.succeeded`, `charge.refunded`, `checkout.session.expired`, `charge.dispute.created`, `account.updated` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (this endpoint's signing secret) |
| `pivot-parlor-api` | `https://api.pivotparlor.com/api/webhooks/stripe` | `checkout.session.completed` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (this endpoint's signing secret) |

- The event lists come from the handlers. The booking worker's `switch` is in
  `apps/workers/booking/src/routes/stripe-webhook.ts`; the API's one event is
  in `apps/worker/src/routes/webhooks.ts` (the shop setup fee). The API
  answers 200 to every other event it is sent.
- Both endpoints listen to **your account**, not connected accounts. Deposits
  and sales are destination charges made on the platform account, so their
  events arrive there. `account.updated` for a shop's Express account is a
  connected-account event and never reaches an account-scoped endpoint; the
  "Payments" page's status check polls Stripe and records onboarding instead
  (`GET /:shopId/connect/status`). Listing it costs nothing.
- Each worker has its own endpoint and its own signing secret. Putting one
  endpoint's secret on the other worker makes every signed delivery fail with
  400.
- Shops connect as Express accounts in GB with card payments and transfers
  (`createConnectAccount` in `apps/workers/booking/src/lib/stripe.ts`).

## Before the switch (owner)

1. **Activate the account for live payments.** Stripe asks for the business
   that owns it. This needs the company question settled first (which company
   is the platform, and its number): the same one the DPA and the legal pages
   name.
2. **Add the payout bank account**, and set the statement descriptor shoppers
   will see.
3. **Turn on Connect in live mode** and finish the platform profile Stripe asks
   for (Express accounts, United Kingdom, the platform takes an application
   fee).
4. **Match the Stripe API version.** Request and webhook shapes change between
   API versions, and what was tested is the sandbox's version.
   - The API worker uses the `stripe` package, which pins its own version
     (`2026-02-25.clover` in stripe 20.4.1).
   - The booking worker calls Stripe with plain `fetch` and sends no
     `Stripe-Version` (`apps/workers/booking/src/lib/stripe.ts`), so it gets
     the account's default version.
   - A webhook endpoint's payloads use the version the endpoint was created
     with.

   Read the default API version of the sandbox and of the live account
   (Workbench, Overview). If they match, go on. If they differ, do not change
   the live account's default: other integrations use that account. Pin
   `Stripe-Version` in the booking worker to the sandbox's version instead (a
   code change, tested on staging) before the switch. In 2026-07, a stray
   live-account endpoint carried version 2019-08-14, so expect a difference.

## The switch

1. **Capture a restore point** (section 2 of `docs/DR-RUNBOOK.md`):
   `cd apps/worker && npx wrangler d1 time-travel info pivot-parlor-db --json`.
2. **Forget the sandbox Connect accounts.** Any shop that onboarded in the
   sandbox holds a sandbox account id. The live key cannot see it, and
   onboarding reuses a stored id rather than making a new one, so that shop
   could never onboard again. With no real shop onboarded yet:
   ```bash
   cd apps/worker
   npx wrangler d1 execute pivot-parlor-db --remote --command "SELECT id, name, stripe_connect_account_id FROM shops WHERE stripe_connect_account_id IS NOT NULL"
   npx wrangler d1 execute pivot-parlor-db --remote --command "UPDATE shops SET stripe_connect_account_id = NULL, stripe_connect_onboarded = 0 WHERE stripe_connect_account_id IS NOT NULL"
   ```
   Sandbox payments already in the tables (`bw_transactions`, sales,
   deposits) cannot be refunded with the live key. Clear the demo shop's test
   activity first with the launch purge script (`docs/PURGE-daf88508.sql`,
   kept uncommitted), the way its header says.
3. **Create the two endpoints in live mode**, with the URLs and events in the
   table above, and with the API version of the matching sandbox endpoint
   (its details page shows it). In 2026-07, an endpoint added through
   Workbench landed in a
   different Stripe environment from the key's. Afterwards, check that the
   live key itself lists both:
   `curl -s https://api.stripe.com/v1/webhook_endpoints -u "$KEY:"`, run in
   your own terminal.
4. **Put the secrets.** Use the interactive prompt and paste when asked. In
   2026-07, piping a value from the wrong shell stored an empty secret and
   still said "Success".
   ```bash
   cd apps/workers/booking
   npx wrangler secret put STRIPE_SECRET_KEY        # live secret key
   npx wrangler secret put STRIPE_WEBHOOK_SECRET    # booking endpoint's signing secret
   cd ../../worker
   npx wrangler secret put STRIPE_SECRET_KEY        # the same live secret key
   npx wrangler secret put STRIPE_WEBHOOK_SECRET    # API endpoint's signing secret
   ```
   For a few seconds after a put, old instances still have the old value.

## Proving it

1. Onboard a shop you own through the Payments page, turn deposits on in its
   Settings, and make one real booking paid with your own card for the
   smallest deposit. Then cancel it from the admin bookings screen with the
   deposit refunded.
2. Check that the booking shows as confirmed, the refund shows, and both
   endpoints' delivery logs in the Stripe dashboard show 200.
3. Read the workers' logs for that window (Workers observability): no 400 or
   500 on `/webhooks/stripe` or `/api/webhooks/stripe`.

## Undo

Put the sandbox keys and the sandbox endpoints' signing secrets back on both
workers (same commands). Live payments taken in between stay in the live
account; refund them there.
