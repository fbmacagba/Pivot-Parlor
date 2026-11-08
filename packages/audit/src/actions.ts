/** Fixed action catalogue (spec 3.3). Add actions here, never inline strings. */
export const AUDIT_ACTIONS = [
  "site.activate", "site.pause", "site.regenerate.request", "site.regenerate.complete", "site.edit",
  "site.candidate.publish", "site.candidate.discard",
  "theme.generate", "theme.apply", "theme.compare",
  "shop.create", "shop.update", "shop.delete", "shop.settings.update",
  "service.create", "service.update", "service.delete",
  "staff.create", "staff.update", "staff.delete",
  "schedule.create", "schedule.update", "schedule.delete",
  "product.create", "product.update", "product.delete",
  "booking.create", "booking.update", "booking.cancel", "booking.status",
  "walkin.join", "walkin.serve", "walkin.remove",
  "pos.sale", "payment.refund.issue", "payment.payout", "payment.stripe.webhook",
  "customer.view", "data.export",
  "audit.view", "audit.export", "audit.verify", "audit.expire", "audit.seal.alert",
  "audit.gap", "audit.anchor", "audit.import.historical",
  "ai.call", "ai.chatbot_model.set", "ai.registry.refresh",
  "subject.redact", "subject.erase_request",
  // Plan 2: API worker routes, crons and the reminder queue.
  "inventory.movement", "inventory.reorder",
  "inventory.supplier.create", "inventory.supplier.update",
  "inventory.po.create", "inventory.po.update", "inventory.po.order", "inventory.po.cancel", "inventory.po.receive",
  "inventory.stock_take.open", "inventory.stock_take.count", "inventory.stock_take.complete", "inventory.stock_take.cancel",
  "account.create", "account.update", "account.verify_email", "account.verification.send", "account.invite.accept",
  "auth.login", "auth.logout",
  "waitlist.join", "waitlist.update", "waitlist.notify",
  "review.create", "enquiry.create", "staff.time_off.request",
  "booking.reminder", "booking.eod_summary", "data.retention",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(x: unknown): x is AuditAction {
  return typeof x === "string" && ACTION_SET.has(x);
}
