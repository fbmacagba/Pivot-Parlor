// Worker-authoritative version + document identifiers recorded when a user
// accepts the platform's legal terms at onboarding (see routes/invites.ts and
// migration 043 legal_acceptances). The Data Processing Agreement forms part of
// the Terms of Service and shares this version.
//
// KEEP IN SYNC with DPA_VERSION in apps/web/app/lib/legalEntity.ts. The version
// is recorded server-side, not taken from the client, so it cannot be spoofed.
export const LEGAL_DOC_VERSION = "1.0";

// Values stored in legal_acceptances.document:
//   terms_dpa — a shop admin accepting the Terms + Data Processing Agreement.
//               Only the admin represents the shop as controller under the DPA.
//   terms     — a staff or developer invitee accepting the Terms of Service.
export const LEGAL_DOC_TERMS_DPA = "terms_dpa";
export const LEGAL_DOC_TERMS = "terms";
