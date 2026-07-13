// apps/web/app/lib/legalDates.ts
//
// "Last updated" dates for the legal / policy documents.
//
// These are hand-maintained CONTENT-CHANGE dates, not render-time values.
// When you edit a document's copy, bump that document's date here. Do NOT
// replace these with new Date(): the "Last updated" line must reflect when the
// policy TEXT last changed, never when the page happened to be viewed or
// deployed (that would claim the policy changed every single day and is also a
// server/client hydration mismatch on the Worker, which runs in UTC).
//
// Two independent sets. The platform (Pivot Parlor marketing) legal pages and
// the per-shop template legal pages are separate bodies of text with separate
// change histories, so each carries its own date even when the values match.

export const PLATFORM_LEGAL_LAST_UPDATED = {
  privacy: "March 2026",
  terms: "March 2026",
  cookies: "March 2026",
} as const;

export const SHOP_LEGAL_LAST_UPDATED = {
  privacy: "March 2026",
  terms: "March 2026",
  cookies: "March 2026",
} as const;
