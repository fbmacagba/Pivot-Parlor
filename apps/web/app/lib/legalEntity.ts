// Single source of truth for BytesFX Ltd's legal-entity identifiers used across
// the platform's legal documents (Terms, Privacy, DPA). Update in ONE place.
//
// Author note: these are static facts of record - never derive them at runtime
// (no new Date(), no env lookups), the same rule as legalDates.ts.

export interface LegalEntity {
  legalName: string;
  tradingAs: string;
  jurisdiction: string;
  /**
   * Companies House registered number. REQUIRED before the DPA (a binding
   * contract that names BytesFX Ltd as a party) is published: a live contract
   * must not name a bracketed party. Fill this in before merging /dpa.
   */
  companyNumber: string | null;
  registeredOffice: string;
  contactEmail: string;
  /**
   * ICO data-protection-fee registration (ZA######). null until BytesFX Ltd
   * registers with the ICO and pays the annual data protection fee (a
   * computerised SaaS booking platform is a fee-paying controller; no exemption
   * applies; Tier 1 is ~GBP 52/yr). When set, the reference surfaces on the DPA
   * and can be added to the privacy and cookie pages (closes LEG-7).
   */
  icoRegistration: string | null;
}

export const LEGAL_ENTITY: LegalEntity = {
  legalName: "BytesFX Ltd",
  tradingAs: "Pivot Parlor",
  jurisdiction: "England and Wales",
  companyNumber: null,
  registeredOffice: "Moselle Avenue, London, N22 6ET, United Kingdom",
  contactEmail: "dev@pivotparlor.com",
  icoRegistration: null,
};

/** DPA document version. Bump when the DPA text materially changes. */
export const DPA_VERSION = "1.0";

/**
 * DPA effective month (static string, never new Date()). Reviewed against UK
 * data protection law as commenced to this date, including the Data (Use and
 * Access) Act 2025.
 */
export const DPA_EFFECTIVE = "July 2026";
