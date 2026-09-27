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
  "POST /api/ai/apply-theme": "theme.apply",
  "POST /api/ai/chatbot-model": "ai.chatbot_model.set",
  "POST /api/ai/compare": "theme.compare",
  "POST /api/ai/generate-theme": "theme.generate",
  // Task 11 adds the three /api/audit POST routes here.

  // Plan 2
  "DELETE /api/shops/:shopId/products/:productId": "pending",
  "DELETE /api/shops/:shopId/products/:productId/variants/:variantId": "pending",
  "DELETE /api/shops/:shopId/services/:serviceId": "pending",
  "DELETE /api/shops/:shopId/staff/:staffId": "pending",
  "DELETE /api/shops/:shopId/walkin": "pending",
  "PATCH /api/me/profile": "pending",
  "PATCH /api/shops/:shopId": "pending",
  "PATCH /api/shops/:shopId/settings": "pending",
  "PATCH /api/shops/:shopId/walkin/:entryId": "pending",
  "PATCH /api/waitlist/:id/status": "pending",
  "POST /api/bookings": "pending",
  "POST /api/bookings/:bookingId/abandon": "pending",
  "POST /api/contact": "pending",
  "POST /api/invites/:token/accept": "pending",
  "POST /api/me/bookings/:bookingId/cancel": "pending",
  "POST /api/shops": "pending",
  "POST /api/shops/:shopId/generate-image": "pending",
  "POST /api/shops/:shopId/inventory/movements": "pending",
  "POST /api/shops/:shopId/products": "pending",
  "POST /api/shops/:shopId/products/:productId/variants": "pending",
  "POST /api/shops/:shopId/products/categories": "pending",
  "POST /api/shops/:shopId/purchase-orders": "pending",
  "POST /api/shops/:shopId/purchase-orders/:poId/cancel": "pending",
  "POST /api/shops/:shopId/purchase-orders/:poId/order": "pending",
  "POST /api/shops/:shopId/purchase-orders/:poId/receive": "pending",
  "POST /api/shops/:shopId/remove-image": "pending",
  "POST /api/shops/:shopId/reviews": "pending",
  "POST /api/shops/:shopId/save-image": "pending",
  "POST /api/shops/:shopId/services": "pending",
  "POST /api/shops/:shopId/settings": "pending",
  "POST /api/shops/:shopId/staff": "pending",
  "POST /api/shops/:shopId/staff/:staffId/avatar": "pending",
  "POST /api/shops/:shopId/stock-takes": "pending",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/cancel": "pending",
  "POST /api/shops/:shopId/stock-takes/:stockTakeId/complete": "pending",
  "POST /api/shops/:shopId/suppliers": "pending",
  "POST /api/shops/:shopId/upload-image": "pending",
  "POST /api/staff/me/time-off": "pending",
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
  "PUT /api/shops/:shopId/inventory/reorder": "pending",
  "PUT /api/shops/:shopId/products/:productId": "pending",
  "PUT /api/shops/:shopId/products/:productId/variants/:variantId": "pending",
  "PUT /api/shops/:shopId/products/categories/:categoryId": "pending",
  "PUT /api/shops/:shopId/purchase-orders/:poId": "pending",
  "PUT /api/shops/:shopId/schedule": "pending",
  "PUT /api/shops/:shopId/services/:serviceId": "pending",
  "PUT /api/shops/:shopId/services/:serviceId/products": "pending",
  "PUT /api/shops/:shopId/staff/:staffId": "pending",
  "PUT /api/shops/:shopId/stock-takes/:stockTakeId/items": "pending",
  "PUT /api/shops/:shopId/suppliers/:supplierId": "pending",
  "PUT /api/staff/me/bookings/:bookingId/status": "pending",
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
export const PENDING_CEILING = 66;
