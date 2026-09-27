/** Fixed action catalogue (spec 3.3). Add actions here, never inline strings. */
export const AUDIT_ACTIONS = [
  "site.activate", "site.pause", "site.regenerate.request", "site.regenerate.complete", "site.edit",
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
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export function isAuditAction(x: unknown): x is AuditAction {
  return typeof x === "string" && ACTION_SET.has(x);
}
