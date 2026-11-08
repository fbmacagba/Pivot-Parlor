export const AUDIT_FILTERS = ["shop_id", "actor", "action", "outcome", "from", "to", "request_id", "cursor"] as const;

export function auditQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of AUDIT_FILTERS) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

/** The two date-range params in isolation. The subject export (unlike the
 *  main list/CSV/proof export) accepts only `from`/`to`, not the full
 *  filter set, so its download link and the export route's subject branch
 *  need just these two rather than the full `auditQuery`. */
export function dateOnlyQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of ["from", "to"] as const) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

export function entryStatus(e: { sealed_at: string | null; archived_at: string | null }): {
  label: "Pending" | "Sealed" | "Archived";
  variant: "warning" | "default" | "success";
} {
  if (e.archived_at) return { label: "Archived", variant: "success" };
  if (e.sealed_at) return { label: "Sealed", variant: "default" };
  return { label: "Pending", variant: "warning" };
}

// Every action in the catalogue (packages/audit/src/actions.ts) has a label
// here; apps/worker/test/audit-labels.test.ts fails when one is missing. Each
// label says what the entry records, in past tense, and never claims success:
// the outcome is shown separately. Anything not in the catalogue falls back to
// the raw action string below.
const LABELS: Record<string, string> = {
  "site.activate": "Site made live",
  "site.pause": "Site paused",
  "site.regenerate.request": "Site regeneration requested",
  "site.regenerate.complete": "Site regeneration finished",
  "site.edit": "Site edited",
  "site.candidate.publish": "New site version published",
  "site.candidate.discard": "New site version discarded",
  "theme.generate": "Theme generated",
  "theme.apply": "Theme applied",
  "theme.compare": "Themes compared",
  "shop.create": "Shop created",
  "shop.update": "Shop details updated",
  "shop.delete": "Shop deleted",
  "shop.settings.update": "Shop settings updated",
  "service.create": "Service added",
  "service.update": "Service updated",
  "service.delete": "Service removed",
  "staff.create": "Staff member added",
  "staff.update": "Staff member updated",
  "staff.delete": "Staff member removed",
  "staff.time_off.request": "Time off requested",
  "schedule.create": "Schedule added",
  "schedule.update": "Schedule updated",
  "schedule.delete": "Schedule removed",
  "product.create": "Product added",
  "product.update": "Product updated",
  "product.delete": "Product removed",
  "inventory.movement": "Stock level changed",
  "inventory.reorder": "Reorder level changed",
  "inventory.supplier.create": "Supplier added",
  "inventory.supplier.update": "Supplier updated",
  "inventory.po.create": "Purchase order created",
  "inventory.po.update": "Purchase order updated",
  "inventory.po.order": "Purchase order placed",
  "inventory.po.cancel": "Purchase order cancelled",
  "inventory.po.receive": "Stock received",
  "inventory.stock_take.open": "Stock take opened",
  "inventory.stock_take.count": "Stock count recorded",
  "inventory.stock_take.complete": "Stock take completed",
  "inventory.stock_take.cancel": "Stock take cancelled",
  "booking.create": "Booking made",
  "booking.update": "Booking updated",
  "booking.cancel": "Booking cancelled",
  "booking.status": "Booking status changed",
  "booking.reminder": "Reminder sent",
  "booking.eod_summary": "End of day summary sent",
  "walkin.join": "Walk-in joined queue",
  "walkin.serve": "Walk-in served",
  "walkin.remove": "Walk-in removed from queue",
  "waitlist.join": "Waitlist joined",
  "waitlist.update": "Waitlist entry updated",
  "waitlist.notify": "Waitlist notified",
  "pos.sale": "Till sale recorded",
  "payment.refund.issue": "Refund issued",
  "payment.payout": "Payout recorded",
  "payment.stripe.webhook": "Stripe event received",
  "account.create": "Account created",
  "account.update": "Account updated",
  "account.verify_email": "Email address verified",
  "account.verification.send": "Verification email sent",
  "account.invite.accept": "Invite accepted",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "review.create": "Review submitted",
  "enquiry.create": "Enquiry submitted",
  "customer.view": "Customer details viewed",
  "data.retention": "Old records cleared",
  "ai.call": "AI call",
  "ai.chatbot_model.set": "Chatbot model changed",
  "ai.registry.refresh": "AI model list refreshed",
  "audit.view": "Activity viewed",
  "audit.export": "Activity exported",
  "audit.verify": "Trail checked",
  "audit.gap": "Unlabelled change",
  "audit.expire": "Old entries expired",
  "audit.seal.alert": "Integrity alert",
  "audit.anchor": "Daily fingerprint emailed",
  "audit.import.historical": "AI history imported",
  "subject.redact": "Personal details blanked",
  "subject.erase_request": "Erasure requested",
  "data.export": "Personal data exported",
};

export function actionLabel(action: string): string {
  return LABELS[action] ?? action;
}

/** The trail is a UK business record: show its times in UK time (GMT/BST)
 *  whatever zone the server rendering the page, or the viewer's browser, is
 *  in, so the server render and the browser agree (M6). */
const UK_TIME_ZONE = "Europe/London";

export function formatAuditDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: UK_TIME_ZONE });
}

export function formatAuditDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: UK_TIME_ZONE });
}

/** Escapes the five HTML-significant characters. The audit export error page
 *  (dev.activity.export.tsx) interpolates the upstream API's `error` message
 *  into hand-built HTML; that message is attacker-influenceable free text
 *  (Ruling 41's shape validation lives on the worker and rejects most bad
 *  input, but a message string itself is never guaranteed HTML-safe), so it
 *  must never be interpolated raw (Ruling 49). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The plain, readable page shown when the export download's upstream fetch
 *  fails (400 "Too many entries…", 404 "Subject not found", the 503 audit
 *  refusal, …) instead of the JSON error body downloading as a corrupt
 *  "audit-export.csv"/"audit-proof.json" file. `message` is escaped before
 *  interpolation (Ruling 49); the route also sends this alongside a
 *  restrictive Content-Security-Policy header and no Content-Disposition. */
export function auditExportErrorHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Export failed</title>
<style>
  body { background: #0D0D0D; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; }
  a { color: #C9A84C; }
</style>
</head>
<body>
<h1>Could not export activity</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/dev/activity">Back to Activity</a></p>
</body>
</html>`;
}

export const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "site.", label: "Website" },
  { value: "theme.", label: "Themes" },
  { value: "shop.", label: "Shops" },
  { value: "service.", label: "Services" },
  { value: "staff.", label: "Staff" },
  { value: "schedule.", label: "Schedules" },
  { value: "product.", label: "Products" },
  { value: "inventory.", label: "Inventory" },
  { value: "booking.", label: "Bookings" },
  { value: "walkin.", label: "Walk-ins" },
  { value: "waitlist.", label: "Waitlist" },
  { value: "payment.", label: "Payments" },
  { value: "account.", label: "Accounts" },
  { value: "auth.", label: "Sign-ins" },
  { value: "review.", label: "Reviews" },
  { value: "enquiry.", label: "Enquiries" },
  { value: "data.", label: "Data" },
  { value: "ai.", label: "AI" },
  { value: "audit.", label: "Audit trail" },
  { value: "subject.", label: "Personal data" },
];
