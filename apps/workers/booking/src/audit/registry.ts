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
  "POST /public/bookings": "booking.create",
  "POST /public/bookings/:bookingId/abandon": "booking.cancel",
  // Task 5
  "POST /booking/shops/:shopId/bookings": "booking.create",
  "POST /booking/shops/:shopId/walk-ins": "booking.create",
  "POST /booking/shops/:shopId/check-in": "booking.check_in",
  "POST /booking/shops/:shopId/bookings/:bookingId/checkout": "booking.checkout",
  "POST /booking/shops/:shopId/bookings/:bookingId/cancel": "booking.cancel",
  // Task 6
  "POST /booking/shops/:shopId/sales": "pending",
  "POST /booking/shops/:shopId/sales/:saleId/refund": "pending",
  "POST /booking/shops/:shopId/sales/:saleId/void": "pending",
  // Task 7
  "POST /webhooks/stripe": "pending",
};

export const CRON_AUDIT: Record<string, AuditDeclaration> = {
  "*/15 * * * *": "booking.cancel",
};

/** Ratchet: only ever lowered (Plan 3 brings it to 0). */
export const PENDING_CEILING = 4;
