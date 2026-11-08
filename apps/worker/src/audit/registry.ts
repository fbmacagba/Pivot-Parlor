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
  "DELETE /api/shops/:shopId/walkin": "pending",
  "PATCH /api/me/profile": "pending",
  "PATCH /api/shops/:shopId": "pending",
  "PATCH /api/shops/:shopId/settings": "pending",
  "PATCH /api/shops/:shopId/walkin/:entryId": "pending",
  "PATCH /api/waitlist/:id/status": "pending",
  "POST /api/contact": "pending",
  "POST /api/invites/:token/accept": "pending",
  "POST /api/me/bookings/:bookingId/cancel": "pending",
  "POST /api/shops": "pending",
  "POST /api/shops/:shopId/generate-image": "pending",
  "POST /api/shops/:shopId/inventory/movements": "inventory.movement",
  "POST /api/shops/:shopId/products": "product.create",
  "POST /api/shops/:shopId/products/:productId/variants": "product.create",
  "POST /api/shops/:shopId/products/categories": "product.create",
  "POST /api/shops/:shopId/purchase-orders": "inventory.po.create",
  "POST /api/shops/:shopId/purchase-orders/:poId/cancel": "inventory.po.cancel",
  "POST /api/shops/:shopId/purchase-orders/:poId/order": "inventory.po.order",
  "POST /api/shops/:shopId/purchase-orders/:poId/receive": "inventory.po.receive",
  "POST /api/shops/:shopId/remove-image": "pending",
  "POST /api/shops/:shopId/reviews": "pending",
  "POST /api/shops/:shopId/save-image": "pending",
  "POST /api/shops/:shopId/services": "service.create",
  "POST /api/shops/:shopId/settings": "pending",
  "POST /api/shops/:shopId/staff": "staff.create",
  "POST /api/shops/:shopId/staff/:staffId/avatar": "staff.update",
  "POST /api/shops/:shopId/stock-takes": "inventory.stock_take.open",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/cancel": "inventory.stock_take.cancel",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/complete": "inventory.stock_take.complete",
  "POST /api/shops/:shopId/suppliers": "inventory.supplier.create",
  "POST /api/shops/:shopId/upload-image": "pending",
  "POST /api/staff/me/time-off": "staff.time_off.request",
  "POST /api/waitlist": "pending",
  "POST /api/waitlist/:id/notify": "pending",
  "POST /api/walkin/:shopSlug/join": "pending",
  "POST /api/webhooks/stripe": "pending",
  "POST /auth/login": "pending",
  "POST /auth/logout": "pending",
  "POST /auth/register": "pending",
  "POST /auth/resend-verification": "pending",
  "POST /auth/verify-email": "pending",
  "POST /contact": "pending",
  "PUT /api/shops/:shopId/bookings/:bookingId/status": "pending",
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

  // Plan 3: forwarded to the booking worker; the booking worker records them, and the hop becomes exempt then.
  "POST /api/bookings": "pending",
  "POST /api/bookings/:bookingId/abandon": "pending",
  "ALL /api/shops/:shopId/connect/:action": "pending",
  "ALL /api/shops/:shopId/sales": "pending",
  "ALL /api/shops/:shopId/sales/:saleId": "pending",
  "ALL /api/shops/:shopId/sales/:saleId/void": "pending",
  "ALL /api/shops/:shopId/sales/:saleId/refund": "pending",
};

export const CRON_AUDIT: Record<string, AuditDeclaration> = {
  "* * * * *": { exempt: "audit infrastructure: the sealer only fills the one-time sealing columns" },
  "0 3 * * *": "pending",
  "0 8 * * *": "pending",
  "0 20 * * *": "pending",
};

export const QUEUE_AUDIT: Record<string, AuditDeclaration> = {
  "pivot-parlor-reminders": "pending",
  "pivot-parlor-reminders-staging": "pending",
};

/** Ratchet: only ever lowered (Plans 2 and 3 bring it to 0). */
export const PENDING_CEILING = 39;
