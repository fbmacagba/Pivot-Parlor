# Live Shop Maps from the Address — Design

Date: 2026-07-20
Status: Approved in brainstorming, pending implementation plan.
Owner decisions captured via AskUserQuestion in the design session.

## Problem

Shop sites already render a live Google Maps embed in both location variants
(`LocationSection`, `LocationMapFirstSection`), but only when `lat`/`lng` are
set in shop settings. Those are manual optional fields no owner realistically
fills in: the one live production shop has an address
("138 Moselle Avenue, N22 6ET, London") and NULL coordinates, so visitors see
the address as plain text and the map feature is effectively dead.

## Decisions (user-confirmed)

- **Address-based embed** (over geocode-at-save and the Maps JS API): when
  coordinates are absent, embed Google Maps by querying the bare address. No
  API key, no billing, no new infrastructure. `lat`/`lng` remain as a
  precision override for shops whose address pins poorly.
- **Scope:** both shop-site location variants, plus a "Get directions" link
  under the map in both, plus a compact map + directions on the booking
  confirmation screen.
- **Applies to ALL live sites immediately** (v1/v2/v3 alike) — deliberately
  NOT gated on design_version, because the goal is maps with zero owner
  effort. The production shop gets a live map on the next Pages deploy.

## Design

### 1. Shared URL helper (`@repo/utils`)

`googleMapsEmbedUrl(query: string): string` beside the existing
`googleMapsUrl` in `packages/utils/src/emailTemplate.ts`, returning
`https://www.google.com/maps?q=<encodeURIComponent(query)>&output=embed`.

Same documented rule as `googleMapsUrl` (user-observed, 2026-07-13): query
the **bare address** — prefixing the business name only pins when Google
lists the business, otherwise a pinless search view. Additive export: no
behavior change for existing consumers, no worker redeploys required.

### 2. Shop-site location sections

In `LocationSection.tsx` and `LocationMapFirstSection.tsx`:

- Map iframe `src` becomes: coordinates embed when `lat != null && lng != null`
  (unchanged, precision override), otherwise
  `googleMapsEmbedUrl(settings.address)`.
- Both sections already null-guard on `hasAddress`, so the map now always
  renders; the plain address-text fallback panel inside the map frame is
  removed (dead branch).
- New **"Get directions"** link under the map in both variants:
  `<a href={googleMapsUrl(address)} target="_blank" rel="noopener noreferrer">`,
  styled as the accent-border secondary button (min-h-11+, `--st-*` tokens
  only, no em-dashes). Opens the native maps app on mobile.

### 3. Booking confirmation (`$shopSlug.confirm.tsx`)

Confirmed state only (not the settling or cancelled states): when
`layoutData?.settings?.address` is non-empty, render a compact map embed
(rounded, token border, ~16/10 aspect) above the button stack, and add a
"Get directions" `ThemedButton` link. Settings already reach the page via
`useRouteLoaderData` of the `$shopSlug` layout — no loader changes. Both
shells (shop chrome and `platformFallbackVars`) provide the `--st-*` tokens
the block uses.

## Constraints

- Colors via `--st-*`/`--color-*` tokens only; 44px+ touch targets; no
  em-dashes in user-facing text; no new dependencies; no migrations; no
  worker changes.
- The byte-parity suite must stay green (it compares legacy vs v3 rendering
  of the same components — both sides change together).
- The staging booking E2E must stay green (confirmation screen changes —
  check its selectors before altering markup around them).

## Testing

- Component tests (jsdom, `renderToStaticMarkup`): address-only → iframe src
  contains the encoded address; coords present → coords URL wins; directions
  link href uses `googleMapsUrl`; both variants keep their null-guard when
  no address.
- Full web suite (parity included), tsc, zero-warning lint, root build.
- E2E: staging booking smoke unchanged/green.

## Rollout

Single small PR (`apps/web` + `packages/utils`), autonomous lane (no
auth/payment/legal), user merges after CI green. Pages deploy via CI on
merge; no worker deploys needed.
