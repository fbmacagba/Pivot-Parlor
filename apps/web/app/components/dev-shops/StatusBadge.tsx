// The shop's account state on the developer "Shops" list. The pill itself is
// the shared back-office StatusBadge, so its colours follow the one status
// mapping; only the wording is this screen's.
import { StatusBadge as SharedStatusBadge } from "~/components/ui/StatusBadge";
import type { Shop } from "./types";

export function StatusBadge({ shop }: { shop: Shop }) {
  if (shop.status === "active") return <SharedStatusBadge status="active" />;
  // "failed" is the shared error pill; a suspended shop is not trading.
  if (shop.status === "suspended") return <SharedStatusBadge status="failed" label="Suspended" />;
  if (shop.status === "awaiting_payment" || shop.stripe_payment_status === "unpaid") {
    return <SharedStatusBadge status="pending" label="Awaiting Payment" />;
  }
  if (shop.stripe_payment_status === "paid") return <SharedStatusBadge status="paid" />;
  return <SharedStatusBadge status="pending" />;
}

/** The site's own state, separate from the shop account's. */
export function SiteStatusBadge({ shop }: { shop: Shop }) {
  if (!shop.has_site) return <SharedStatusBadge status="inactive" label="No site" />;
  const ws = (shop.website_status ?? "draft").toLowerCase();
  if (ws === "live") return <SharedStatusBadge status="live" label="Site live" />;
  if (ws === "paused") return <SharedStatusBadge status="paused" label="Site paused" />;
  return <SharedStatusBadge status="draft" label="Site draft" />;
}
