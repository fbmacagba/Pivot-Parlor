// Shop status badge for the developer "Shops" dashboard.
// Extracted from dev.shops.tsx (T7.7, was the `statusBadge` closure) — no behavior change.
import { Badge } from "~/components/ui/Badge";
import type { Shop } from "./types";

export function StatusBadge({ shop }: { shop: Shop }) {
  if (shop.status === "active") return <Badge variant="success">Active</Badge>;
  if (shop.status === "suspended") return <Badge variant="error">Suspended</Badge>;
  if (shop.status === "awaiting_payment" || shop.stripe_payment_status === "unpaid") {
    return <Badge variant="warning">Awaiting Payment</Badge>;
  }
  if (shop.stripe_payment_status === "paid") return <Badge variant="success">Paid</Badge>;
  return <Badge variant="warning">Pending</Badge>;
}
