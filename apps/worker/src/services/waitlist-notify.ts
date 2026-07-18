// apps/worker/src/services/waitlist-notify.ts
// Shared "a slot just opened" fan-out, called from both cancellation paths
// (admin status change, customer self-cancel). Deliberately capped and
// sequential: workerd allows only 6 simultaneous outbound connections and
// miniflare does not enforce it (the exact cliff fixed for the reminder cron
// in PR #54), and notifying a bounded batch per freed slot avoids spamming a
// long waitlist for a single opening.

import {
  claimWaitlistNotification,
  getWaitingEntriesForOpenedSlot,
  revertWaitlistNotification,
} from "../db/queries.js";
import { sendWaitlistSlotOpen } from "./email.js";
import { reportError } from "./report-error.js";

export const WAITLIST_NOTIFY_CAP = 3;

/**
 * Notify waiting waitlist entries that match a freed slot (shop + date +
 * staff; NULL entry fields are wildcards). Each entry is atomically claimed
 * (status waiting → notified) before sending so concurrent cancellations
 * never double-email; a failed send reverts the claim so the entry is not
 * stranded as notified with no email. Returns the number actually emailed.
 */
export async function notifyWaitlistForOpenedSlot(
  db: D1Database,
  apiKey: string | undefined,
  shop: { id: string; name: string; slug: string },
  slot: { bookingDate: string; staffId: string },
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

      const claim = await claimWaitlistNotification(db, entry.id);
      if (!claim.meta || claim.meta.changes === 0) continue; // lost the race

      try {
        await sendWaitlistSlotOpen(apiKey, {
          customer_name: entry.customer_name,
          customer_email: entry.customer_email,
          shop_name: shop.name,
          shop_slug: shop.slug,
          service_name: entry.service_name,
          preferred_date: entry.preferred_date,
        });
        sent++;
      } catch (err) {
        reportError("waitlist.slot_open_email", err, {
          entryId: entry.id,
          shopId: shop.id,
        });
        await revertWaitlistNotification(db, entry.id);
      }
    }
  }
  return sent;
}
