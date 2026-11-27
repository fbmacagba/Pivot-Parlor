import { Badge } from "./Badge";

type BadgeVariant = "default" | "gold" | "success" | "warning" | "error" | "outline";

/**
 * Every back-office status pill (DESIGN.md, "Status mapping"): pending is
 * warning, confirmed is success, completed is neutral, cancelled or failed is
 * error. In progress takes the one gold, since it is the live thing in the
 * room. No screen keeps its own colour map, and none of them is blue.
 */
const STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  // Bookings
  pending: { label: "Pending", variant: "warning" },
  confirmed: { label: "Confirmed", variant: "success" },
  in_progress: { label: "In progress", variant: "gold" },
  completed: { label: "Completed", variant: "default" },
  cancelled: { label: "Cancelled", variant: "error" },
  no_show: { label: "No show", variant: "outline" },
  // Walk-in queue and waitlist
  waiting: { label: "Waiting", variant: "warning" },
  called: { label: "Called", variant: "gold" },
  serving: { label: "Being served", variant: "gold" },
  served: { label: "Served", variant: "default" },
  skipped: { label: "Skipped", variant: "outline" },
  notified: { label: "Notified", variant: "gold" },
  offered: { label: "Offered", variant: "gold" },
  claimed: { label: "Claimed", variant: "success" },
  booked: { label: "Booked", variant: "success" },
  expired: { label: "Expired", variant: "outline" },
  removed: { label: "Removed", variant: "outline" },
  // Sales and payments
  paid: { label: "Paid", variant: "success" },
  refunded: { label: "Refunded", variant: "outline" },
  partially_refunded: { label: "Part refunded", variant: "warning" },
  voided: { label: "Voided", variant: "error" },
  failed: { label: "Failed", variant: "error" },
  disputed: { label: "Disputed", variant: "error" },
  // Stock: purchase orders and stock takes
  draft: { label: "Draft", variant: "outline" },
  ordered: { label: "Ordered", variant: "warning" },
  partially_received: { label: "Part received", variant: "gold" },
  received: { label: "Received", variant: "success" },
  open: { label: "Open", variant: "warning" },
  partial: { label: "Part received", variant: "gold" },
  // Staff time off
  approved: { label: "Approved", variant: "success" },
  denied: { label: "Denied", variant: "error" },
  // Shops
  awaiting_payment: { label: "Awaiting payment", variant: "warning" },
  suspended: { label: "Suspended", variant: "error" },
  active: { label: "Active", variant: "success" },
  inactive: { label: "Inactive", variant: "outline" },
  paused: { label: "Paused", variant: "warning" },
  live: { label: "Live", variant: "success" },
};

/** "no_show" reads "No show" when a status has no entry of its own. */
function humanise(status: string): string {
  const words = status.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unknown";
}

export function statusLabel(status: string): string {
  return STATUS[status]?.label ?? humanise(status);
}

export function statusVariant(status: string): BadgeVariant {
  return STATUS[status]?.variant ?? "default";
}

interface StatusBadgeProps {
  status: string;
  /** Overrides the wording while keeping the status colour. */
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <Badge variant={statusVariant(status)} className={className}>
      {label ?? statusLabel(status)}
    </Badge>
  );
}
