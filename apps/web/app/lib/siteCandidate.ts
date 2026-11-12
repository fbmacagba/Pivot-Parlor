/** Owner review (migration 049): shared by the dashboard card and the shop
 *  page's preview bar. */

import { formatDateTime } from "./dateFormat";

/** "6 Nov, 13:05" in UK time, so the owner and the developer read the same clock. */
export function formatMadeAt(iso: string): string {
  if (!iso) return "";
  return formatDateTime(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
