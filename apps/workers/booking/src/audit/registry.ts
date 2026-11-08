import type { AuditAction } from "@repo/audit";

/** An action from the catalogue, "pending" (not yet instrumented; the gap
 *  guard still records an audit.gap entry), or a reasoned exemption. */
export type AuditDeclaration = AuditAction | "pending" | { exempt: string };

export const ROUTE_AUDIT: Record<string, AuditDeclaration> = {
  // Task 2
  "POST /booking/shops/:shopId/complete-setup": "shop.setup.complete",
  "POST /booking/platform/alerts/:alertId/resolve": "platform.alert.resolve",
  "POST /booking/shops/:shopId/connect/onboard": "payment.connect.onboard",
  // Task 3
  "POST /booking/shops/:shopId/open": "day.open",
  "POST /booking/shops/:shopId/close": "day.close",
  // Task 4
  "POST /public/bookings": "pending",
  "POST /public/bookings/:bookingId/abandon": "pending",
  // Task 5
  "POST /booking/shops/:shopId/bookings": "pending",
  "POST /booking/shops/:shopId/walk-ins": "pending",
  "POST /booking/shops/:shopId/check-in": "pending",
  "POST /booking/shops/:shopId/bookings/:bookingId/checkout": "pending",
  "POST /booking/shops/:shopId/bookings/:bookingId/cancel": "pending",
  // Task 6
  "POST /booking/shops/:shopId/sales": "pending",
  "POST /booking/shops/:shopId/sales/:saleId/refund": "pending",
  "POST /booking/shops/:shopId/sales/:saleId/void": "pending",
  // Task 7
  "POST /webhooks/stripe": "pending",
};

export const CRON_AUDIT: Record<string, AuditDeclaration> = {
  "*/15 * * * *": "pending",
};

/** Ratchet: only ever lowered (Plan 3 brings it to 0). */
export const PENDING_CEILING = 12;
