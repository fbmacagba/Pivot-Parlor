import type { AuditAction } from "@repo/audit";

/** An action from the catalogue, "pending" (not yet instrumented; the gap
 *  guard still records an audit.gap entry), or a reasoned exemption. */
export type AuditDeclaration = AuditAction | "pending" | { exempt: string };

export const ROUTE_AUDIT: Record<string, AuditDeclaration> = {
  // Instrumented in Plan 1
  "DELETE /api/shops/:shopId": "shop.delete",
  "POST /api/shops/:shopId/delete": "shop.delete",
  "POST /api/shops/:shopId/activate": "site.activate",
  "POST /api/shops/:shopId/pause": "site.pause",
  "POST /api/shops/:shopId/generate-site": "site.regenerate.request",
  // Owner review of a regenerated site (#111), added when the audit trail
  // was merged with it: publishing replaces what a live site shows.
  "POST /api/shops/:shopId/site-candidate/publish": "site.candidate.publish",
  "DELETE /api/shops/:shopId/site-candidate": "site.candidate.discard",
  "POST /api/ai/apply-theme": "theme.apply",
  "POST /api/ai/chatbot-model": "ai.chatbot_model.set",
  "POST /api/ai/compare": "theme.compare",
  "POST /api/ai/generate-theme": "theme.generate",
  "POST /api/audit/verify": "audit.verify",
  "POST /api/audit/import-historical": "audit.import.historical",
  "POST /api/audit/subjects/:userId/erase": "subject.erase_request",

  // Plan 2
  "DELETE /api/shops/:shopId/products/:productId": "product.delete",
  "DELETE /api/shops/:shopId/products/:productId/variants/:variantId": "product.delete",
  "DELETE /api/shops/:shopId/services/:serviceId": "service.delete",
  "DELETE /api/shops/:shopId/staff/:staffId": "staff.delete",
  "DELETE /api/shops/:shopId/walkin": "walkin.remove",
  "PATCH /api/me/profile": "account.update",
  "PATCH /api/shops/:shopId": "shop.update",
  "PATCH /api/shops/:shopId/settings": "shop.settings.update",
  // One key, two actions (walkin.serve, or walkin.remove for skipped and
  // removed); the declaration only names the guard's 5xx floor row.
  "PATCH /api/shops/:shopId/walkin/:entryId": "walkin.serve",
  "PATCH /api/waitlist/:id/status": "waitlist.update",
  "POST /api/contact": "enquiry.create",
  "POST /api/invites/:token/accept": "account.invite.accept",
  "POST /api/me/bookings/:bookingId/cancel": "booking.cancel",
  "POST /api/shops": "shop.create",
  "POST /api/shops/:shopId/generate-image": "site.edit",
  "POST /api/shops/:shopId/inventory/movements": "inventory.movement",
  "POST /api/shops/:shopId/products": "product.create",
  "POST /api/shops/:shopId/products/:productId/variants": "product.create",
  "POST /api/shops/:shopId/products/categories": "product.create",
  "POST /api/shops/:shopId/purchase-orders": "inventory.po.create",
  "POST /api/shops/:shopId/purchase-orders/:poId/cancel": "inventory.po.cancel",
  "POST /api/shops/:shopId/purchase-orders/:poId/order": "inventory.po.order",
  "POST /api/shops/:shopId/purchase-orders/:poId/receive": "inventory.po.receive",
  "POST /api/shops/:shopId/remove-image": "site.edit",
  "POST /api/shops/:shopId/reviews": "review.create",
  "POST /api/shops/:shopId/save-image": "site.edit",
  "POST /api/shops/:shopId/services": "service.create",
  "POST /api/shops/:shopId/settings": "shop.settings.update",
  "POST /api/shops/:shopId/staff": "staff.create",
  "POST /api/shops/:shopId/staff/:staffId/avatar": "staff.update",
  "POST /api/shops/:shopId/stock-takes": "inventory.stock_take.open",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/cancel": "inventory.stock_take.cancel",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/complete": "inventory.stock_take.complete",
  "POST /api/shops/:shopId/suppliers": "inventory.supplier.create",
  "POST /api/shops/:shopId/upload-image": "site.edit",
  "POST /api/staff/me/time-off": "staff.time_off.request",
  "POST /api/waitlist": "waitlist.join",
  "POST /api/waitlist/:id/notify": "waitlist.notify",
  "POST /api/walkin/:shopSlug/join": "walkin.join",
  "POST /api/webhooks/stripe": "payment.stripe.webhook",
  "POST /auth/login": "auth.login",
  "POST /auth/logout": "auth.logout",
  // One key, two actions (account.create, then account.verification.send for
  // a public sign-up); the declaration only names the guard's 5xx floor row.
  "POST /auth/register": "account.create",
  "POST /auth/resend-verification": "account.verification.send",
  "POST /auth/verify-email": "account.verify_email",
  "POST /contact": "enquiry.create",
  // One key, two actions (booking.cancel for both cancel forks, else
  // booking.status); the declaration only names the guard's 5xx floor row.
  "PUT /api/shops/:shopId/bookings/:bookingId/status": "booking.status",
  "PUT /api/shops/:shopId/inventory/reorder": "inventory.reorder",
  "PUT /api/shops/:shopId/products/:productId": "product.update",
  "PUT /api/shops/:shopId/products/:productId/variants/:variantId": "product.update",
  "PUT /api/shops/:shopId/products/categories/:categoryId": "product.update",
  "PUT /api/shops/:shopId/purchase-orders/:poId": "inventory.po.update",
  "PUT /api/shops/:shopId/schedule": "schedule.update",
  "PUT /api/shops/:shopId/services/:serviceId": "service.update",
  "PUT /api/shops/:shopId/services/:serviceId/products": "service.update",
  "PUT /api/shops/:shopId/staff/:staffId": "staff.update",
  "PUT /api/shops/:shopId/stock-takes/:stockTakeId/items": "inventory.stock_take.count",
  "PUT /api/shops/:shopId/suppliers/:supplierId": "inventory.supplier.update",
  "PUT /api/staff/me/bookings/:bookingId/status": "booking.status",

  // Plan 3: forwarded to the booking worker, which records each change itself, so the hop is exempt.
  "POST /api/bookings": { exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" },
  "POST /api/bookings/:bookingId/abandon": { exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" },
  "ALL /api/shops/:shopId/connect/:action": { exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" },
  "ALL /api/shops/:shopId/sales": { exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" },
  "ALL /api/shops/:shopId/sales/:saleId": { exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" },
  "ALL /api/shops/:shopId/sales/:saleId/void": { exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" },
  "ALL /api/shops/:shopId/sales/:saleId/refund": { exempt: "pure proxy to the booking worker, which records the change itself (Plan 3)" },
};

export const CRON_AUDIT: Record<string, AuditDeclaration> = {
  "* * * * *": { exempt: "audit infrastructure: the sealer only fills the one-time sealing columns" },
  "0 3 * * *": "data.retention",
  "0 8 * * *": "booking.reminder",
  "0 20 * * *": "booking.eod_summary",
};

export const QUEUE_AUDIT: Record<string, AuditDeclaration> = {
  "pivot-parlor-reminders": "booking.reminder",
  "pivot-parlor-reminders-staging": "booking.reminder",
};

/** Ratchet: only ever lowered (Plans 2 and 3 brought it to 0). */
export const PENDING_CEILING = 0;
