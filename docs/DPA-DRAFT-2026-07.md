# Data Processing Agreement — v1.0 handoff & counsel-review record

> **Status.** The DPA is now published as **v1.0** at the live route
> `apps/web/app/routes/_marketing.dpa.tsx` (served at `/dpa`). **That route is
> the canonical text** — do not re-edit the prose here; edit the route. This
> file is the internal record: what changed from the July 2026 draft and why,
> what still needs a qualified UK data-protection lawyer, and the separate
> compliance actions BytesFX must take.
>
> Business decision on file (2026-07-14): publish v1.0 now and obtain formal
> external legal review later, once the first shops are onboarded. This record
> exists so that review is fast and targeted.

Entity facts live in `apps/web/app/lib/legalEntity.ts` (single source of truth).
Version / effective month live there too (`DPA_VERSION`, `DPA_EFFECTIVE`).

---

## Research applied (all adversarially verified against primary sources)

A research workflow (DUAA currency + Stripe/Cloudflare/Resend roles + ICO Art
28(3) checklist and fee) drove the following corrections vs the original draft.
Every claim below was confirmed by an independent verify pass.

- **DUAA 2025 currency.** The Data (Use and Access) Act 2025 *amends* (does not
  replace) UK GDPR + DPA 2018, so the legal framing stays valid. Applied: (a)
  definitions now cite the instruments "as amended from time to time, including
  by the Data (Use and Access) Act 2025"; (b) "UK GDPR" is pin-cited to DPA 2018
  **s.3(10) (and see s.205(4))** rather than the dated "retained EU GDPR"
  phrasing; (c) the Supervisory Authority is defined as "the ICO **and any
  successor body, including the Information Commission** established under the
  DUAA" — the ICO→Information Commission transfer (DUAA ss.118–119) is
  legislated and imminent but **not yet in force** (as of mid-July 2026 the
  office is even vacant after Commissioner Edwards resigned 19 June 2026); (d)
  added a **complaints-handling assistance** line for the new controller duty in
  force 19 June 2026 (acknowledge within 30 days, respond without undue delay).
  Art 28(3) mandatory clauses and the Art 33/34 breach regime are UNCHANGED by
  DUAA.
- **International transfers (Section 4) — was materially false.** The draft
  claimed "UK/EEA region" residency. Corrected to an honest disclosure: data is
  processed in the US (Stripe, Resend) and replicated globally (Cloudflare
  Workers KV has no residency control; D1/R2 EU jurisdiction is opt-in at
  creation only). Transfers rely on the **UK IDTA Addendum to the EU SCCs** and
  the **UK Extension to the EU-U.S. DPF**, applying the DUAA "data protection
  test" — **not** UK adequacy.
- **Stripe role (Annex 2) — was mislabelled.** Stripe is NOT a plain
  sub-processor: it is the platform's processor for payment facilitation and an
  **independent controller** for fraud / AML / KYC / regulatory purposes. Correct
  entities used: **Stripe Payments Europe, Ltd (SPEL)** = UK DPA counterparty;
  **Stripe Payments UK, Ltd** = FCA-authorised acquirer; **Stripe, LLC (US)** =
  onward importer. Never "Stripe, Inc." Cardholder data is governed by Stripe's
  own DPA.
- **Vendor specifics.** Cloudflare Customer DPA **v6.4 (3 April 2026)**; Resend =
  **Plus Five Five, Inc.** (US). Both on EU SCCs + UK Addendum (DPF
  supplementary), not adequacy.
- **Annex 1** now includes the 4th Art 28(3) descriptive element (the
  controller's obligations and rights) as a discrete row.
- **Commercial defaults chosen (user, 2026-07-14):** breach window **72h**;
  sub-processor change notice **30 days**; deletion grace **30 days**; audit
  cadence **once per rolling 12 months**; governing law **England & Wales**.
- **Liability (Section 5).** Points to **Section 8 (Limitation of Liability) of
  the Terms** (cap = commission paid in the preceding 3 months) plus an Article
  82 note that liability to data subjects is allocated by law regardless of
  contract. (Verified Terms §8 exists and resolves.)

---

## Open items for counsel (deferred, non-blocking to v1.0)

- [ ] Confirm the exact commencement date of the ICO→Information Commission
      transfer (DUAA ss.118–119) before it takes effect; the "successor body"
      wording is future-proofed but the live status should be tracked.
- [ ] Reconcile DPA Section 5 with Terms §8: confirm a **commission-based
      3-month cap** is appropriate for *data-protection* claims specifically, or
      whether a separate/higher cap for data breaches is wanted.
- [ ] Confirm Annex 1 processing details and Annex 3 security measures remain
      accurate as the product evolves.
- [ ] Decide whether to also record shop **acceptance** (click-through at
      onboarding with a stored record). v1.0 publishes the readable page only;
      the DPA "forms part of" the Terms, which shops already accept.

## Separate compliance actions (NOT DPA text — BytesFX to action)

- [ ] **Register with the ICO and pay the annual data protection fee.** A
      computerised SaaS booking platform is a **fee-paying controller** for its
      own platform data (staff, shop-owner, enquiry, marketing); no fee exemption
      applies. At micro scale this is **Tier 1 = £52/yr (£47 by direct debit)**.
      Non-registration risks a fine up to **£4,350**. On issue, set
      `LEGAL_ENTITY.icoRegistration` (the ZA number) — this also closes LEG-7 and
      lets the number surface on the DPA and privacy/cookie pages.
- [ ] **Add the Companies House company number** by setting
      `LEGAL_ENTITY.companyNumber`. Deferred by BytesFX on 2026-07-14 (to be added
      when sorted); v1.0 publishes without it. This is safe: the route omits the
      number cleanly when null (no bracket), and the party is still validly
      identified by legal name + jurisdiction + registered office + trading name.
      Best practice is to add it, so this remains an open item.
- [ ] Operational (reduces transfer exposure, no DPA text change): check whether
      customer personal data actually lands in Cloudflare Workers KV (global
      replication, no residency control); where avoidable, route it to
      EU-jurisdiction D1/R2.

_Reviewed against UK data protection law as commenced to 2026-07-14, including
the Data (Use and Access) Act 2025._
