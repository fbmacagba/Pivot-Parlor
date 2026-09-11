import { Link } from "@remix-run/react";

/**
 * Thumb-reach booking CTA for phones. Fixed to the bottom edge, safe-area
 * aware (see shop-chrome.css), hidden from md up. `visible` is driven by
 * useScrolledPastHero in the chrome: the bar slides in once the hero has
 * scrolled away. While hidden it is aria-hidden and out of the tab order so
 * keyboard and screen-reader users never land on an invisible control.
 */
export function MobileBookingBar({
  shopSlug,
  bookingEnabled,
  visible,
}: {
  shopSlug: string;
  bookingEnabled: boolean;
  visible: boolean;
}) {
  const to = bookingEnabled ? `/${shopSlug}/book` : `/${shopSlug}#services`;
  const label = bookingEnabled ? "Book now" : "View services";
  return (
    <div
      className="pp-bottom-bar md:hidden"
      data-visible={visible ? "true" : "false"}
      aria-hidden={visible ? undefined : true}
    >
      <Link
        to={to}
        tabIndex={visible ? undefined : -1}
        className="flex min-h-12 w-full items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-6 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-black/20 transition active:scale-[0.98]"
      >
        {label} →
      </Link>
    </div>
  );
}
