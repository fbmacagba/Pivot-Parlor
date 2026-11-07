/**
 * WS-8 / LEG-6: time-based retention & anonymisation (SIGN-OFF lane — the
 * windows below are policy and were approved before this shipped).
 *
 * Runs daily from the 03:00 UTC cron. Every sweep is bounded per run and
 * idempotent, so a backlog drains over successive nights instead of fanning
 * out unbounded (the WS-7 parity-gap lesson). D1 Time Travel (30 days,
 * docs/DR-RUNBOOK.md) is the recovery net for a mis-tuned window.
 *
 * What is deliberately KEPT:
 *  - Financial rows (bw_transactions, bw_commission_ledger, sales/sale_items):
 *    UK financial-record retention (~6 years) outlives every window here.
 *    Booking rows are anonymised IN PLACE, never deleted, so money reporting
 *    and the audit trail keep their joins.
 *  - platform_users: account data lives until account deletion (right-to-
 *    erasure is a request flow, not a cron).
 *  - reviews: content the customer chose to publish.
 *  - contacts that onboarded: an active business relationship record.
 *  - audit_log: 6 years (spec 2026-09-26); personal details live in
 *    audit_subjects and are blanked 30 days after a shop leaves or an
 *    erasure request.
 */
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { expireOldEntries, redactDueSubjects } from "../audit/retention.js";
import {
  anonymiseOldBookings,
  deleteExpiredChatSessions,
  deleteExpiredInvites,
  deleteStaleContacts,
  deleteStaleWaitlist,
  pruneAiUsageLog,
} from "../db/queries.js";

/** Retention windows (policy — change only with sign-off). */
export const RETENTION_POLICY = {
  /** Visitor chat transcripts: free text, no business value after support horizon. */
  chatSessionsDays: 90,
  /** Waitlist entries: operational queue rows, finished or abandoned long before this. */
  waitlistDays: 365,
  /** Invites: delete after use/expiry + grace (email + a live token otherwise). */
  invitesGraceDays: 30,
  /** Marketing enquiries that never onboarded. */
  contactsMonths: 24,
  /** Booking PII (name/email/phone/notes) — row and money fields stay. */
  bookingPiiMonths: 24,
  /** AI usage rows: ops metrics only. */
  aiUsageLogMonths: 12,
} as const;

/** Per-table per-run bound; a nightly cron drains any realistic backlog. */
export const RETENTION_MAX_PER_TABLE_PER_RUN = 500;

export type RetentionResult = {
  counts: Record<string, number>;
  errors: Array<{ table: string; error: string }>;
};

/** One nightly pass. Sweeps run independently — one failing table never
 *  blocks the others; failures are returned for the caller to log.
 *  `bucket` is the audit archive (Ruling 40: expireOldEntries re-verifies its
 *  candidate range against R2 immediately before deleting). */
export async function runRetentionSweep(
  db: D1Database,
  bucket: R2Bucket,
  maxPerTable = RETENTION_MAX_PER_TABLE_PER_RUN
): Promise<RetentionResult> {
  const sweeps: Array<[string, () => Promise<number>]> = [
    ["chat_sessions", () => deleteExpiredChatSessions(db, RETENTION_POLICY.chatSessionsDays, maxPerTable)],
    ["waitlist", () => deleteStaleWaitlist(db, RETENTION_POLICY.waitlistDays, maxPerTable)],
    ["invites", () => deleteExpiredInvites(db, RETENTION_POLICY.invitesGraceDays, maxPerTable)],
    ["contacts", () => deleteStaleContacts(db, RETENTION_POLICY.contactsMonths, maxPerTable)],
    ["bookings_anonymised", () => anonymiseOldBookings(db, RETENTION_POLICY.bookingPiiMonths, maxPerTable)],
    ["ai_usage_log", () => pruneAiUsageLog(db, RETENTION_POLICY.aiUsageLogMonths, maxPerTable)],
    ["audit_subjects_redacted", () => redactDueSubjects(db, new Date(), maxPerTable)],
    ["audit_log_expired", () => expireOldEntries(db, bucket, new Date(), maxPerTable)],
  ];

  const counts: Record<string, number> = {};
  const errors: Array<{ table: string; error: string }> = [];
  for (const [table, sweep] of sweeps) {
    try {
      counts[table] = await sweep();
    } catch (err) {
      errors.push({ table, error: String(err) });
    }
  }
  return { counts, errors };
}
