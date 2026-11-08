// apps/worker/src/services/waitlist-notify.ts
// Shared "a slot just opened" fan-out, called from both cancellation paths
// (admin status change, customer self-cancel). Deliberately capped and
// sequential: workerd allows only 6 simultaneous outbound connections and
// miniflare does not enforce it (the exact cliff fixed for the reminder cron
// in PR #54), and notifying a bounded batch per freed slot avoids spamming a
// long waitlist for a single opening.

import { AuditWriteError, type AuditRecorder } from "@repo/audit";
import { getWaitingEntriesForOpenedSlot } from "../db/queries.js";
import { reportError } from "./report-error.js";
import { notifyWaitlistEntry, WaitlistSendError } from "./waitlist-claim.js";

export const WAITLIST_NOTIFY_CAP = 3;

/**
 * Notify waiting waitlist entries that match a freed slot (shop + date +
 * staff; NULL entry fields are wildcards). Each entry is atomically claimed
 * (status waiting → notified) before sending so concurrent cancellations
 * never double-email; a failed send reverts the claim so the entry is not
 * stranded as notified with no email. Returns the number actually emailed.
 *
 * Each email is recorded through `recorder` (`waitlist.notify`, trigger
 * `slot_opened`); callers pass the cancelling request's recorder, so the
 * entry names the person whose cancel freed the slot. An email whose entry
 * cannot be written is skipped like a failed send. Any other error (a D1
 * failure) rejects, and both callers catch and report it: the cancellation
 * that freed the slot always stands.
 */
export async function notifyWaitlistForOpenedSlot(
  db: D1Database,
  apiKey: string | undefined,
  shop: { id: string; name: string; slug: string },
  slot: { bookingDate: string; staffId: string },
  recorder: AuditRecorder,
): Promise<number> {
  if (!apiKey) return 0;

  // Refill loop: a claim lost to a concurrent invocation (another freed slot
  // claiming the same entry) is replaced by re-selecting, so each freed slot
  // still notifies up to the cap. `tried` bounds the loop: every entry is
  // attempted at most once, including entries reverted after a failed send.
  const tried = new Set<string>();
  let sent = 0;
  while (sent < WAITLIST_NOTIFY_CAP) {
    const batch = (
      await getWaitingEntriesForOpenedSlot(
        db,
        shop.id,
        slot.bookingDate,
        slot.staffId,
        WAITLIST_NOTIFY_CAP + tried.size,
      )
    ).filter((e) => !tried.has(e.id));
    if (batch.length === 0) break;

    for (const entry of batch) {
      if (sent >= WAITLIST_NOTIFY_CAP) break;
      tried.add(entry.id);

      try {
        // "lost" means another invocation claimed it first: try the next one.
        if ((await notifyWaitlistEntry(db, apiKey, shop, entry, recorder, "slot_opened")) === "sent") sent++;
      } catch (err) {
        // A failed send (already reverted by the helper) or an entry that
        // could not be recorded (never claimed): report it and move on.
        // Anything else (a D1 error in the claim or the revert) aborts the
        // fan-out into the caller's catch, as it always did.
        if (!(err instanceof WaitlistSendError) && !(err instanceof AuditWriteError)) throw err;
        reportError("waitlist.slot_open_email", err instanceof WaitlistSendError ? err.original : err, {
          entryId: entry.id,
          shopId: shop.id,
        });
      }
    }
  }
  return sent;
}
