/**
 * A dashboard page's document title, "Bookings · Pivot Parlor": what a browser
 * tab, the history list and a screen reader announce on arrival. Use as a
 * route's `meta` export: `export const meta = () => pageTitle("Bookings");`
 */
export function pageTitle(page: string): Array<{ title: string }> {
  return [{ title: `${page} · Pivot Parlor` }];
}
