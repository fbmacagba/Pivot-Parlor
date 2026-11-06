/** Owner review (migration 049): shared by the dashboard card and the shop
 *  page's preview bar. */

/** "6 Nov, 13:05" in UK time, so the owner and the developer read the same clock. */
export function formatMadeAt(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}
