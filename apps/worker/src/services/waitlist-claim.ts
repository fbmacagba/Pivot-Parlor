// apps/worker/src/services/waitlist-claim.ts
// One waitlist "a slot just opened" email, recorded: the started entry
// commits before the claim, so an email that cannot be recorded is never
// claimed or sent. Shared by the manual notify route and the slot-open
// fan-out (services/waitlist-notify.ts).

import type { AuditRecorder, AuditRunResult } from "@repo/audit";
import { claimWaitlistNotification, revertWaitlistNotification } from "../db/queries.js";
import { sendWaitlistSlotOpen } from "./email.js";

export interface WaitlistNotifyEntry {
  id: string;
  customer_name: string;
  customer_email: string;
  service_name: string | null;
  preferred_date: string | null;
}

/**
 * Claim one waiting entry (status waiting → notified) and email it, inside
 * `recorder.run` (action `waitlist.notify`).
 *
 * - A lost claim (someone else claimed it, or it is no longer waiting)
 *   returns "lost" and records `refused` with reason `claim_lost`.
 * - A send failure reverts the claim and rethrows, so `run` records `failed`.
 * - An AuditWriteError from the started entry propagates before the claim.
 */
export async function notifyWaitlistEntry(
  db: D1Database,
  apiKey: string,
  shop: { id: string; name: string; slug: string },
  entry: WaitlistNotifyEntry,
  recorder: AuditRecorder,
  trigger: "manual" | "slot_opened",
): Promise<"sent" | "lost"> {
  return recorder.run(
    {
      action: "waitlist.notify",
      shopId: shop.id,
      entityType: "waitlist_entry",
      entityId: entry.id,
      details: { trigger },
    },
    async (): Promise<"sent" | "lost"> => {
      const claim = await claimWaitlistNotification(db, entry.id);
      if (!claim.meta || claim.meta.changes === 0) return "lost";
      try {
        await sendWaitlistSlotOpen(apiKey, {
          customer_name: entry.customer_name,
          customer_email: entry.customer_email,
          shop_name: shop.name,
          shop_slug: shop.slug,
          service_name: entry.service_name,
          preferred_date: entry.preferred_date,
        });
      } catch (err) {
        // Not stranded as notified with no email.
        await revertWaitlistNotification(db, entry.id);
        throw err;
      }
      return "sent";
    },
    // The claim's WHERE status = 'waiting' fixes the prior status, so the
    // pair is known exactly (no row read can be staler than the claim).
    (result): AuditRunResult =>
      result === "sent"
        ? { outcome: "succeeded", changes: { status: ["waiting", "notified"] } }
        : { outcome: "refused", reason: "claim_lost" },
  );
}
