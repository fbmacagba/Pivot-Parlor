import { recordShopConsent, useMapConsent } from "~/lib/mapConsent";

/**
 * A Google map that loads only with the visitor's consent. Until then (and
 * always in the server HTML) it is a placeholder saying whose map it is and
 * what loading it does, with a "Show map" button that records the consent
 * for every map on the site. The parent gives the box its size.
 */
export function ConsentedMap({ title, src, className = "h-full w-full" }: { title: string; src: string; className?: string }) {
  const consent = useMapConsent();
  if (consent === "granted") {
    return (
      <iframe
        title={title}
        className={`${className} border-0`}
        loading="lazy"
        // Google gets the site's address only, never the page: the booking
        // confirmation page carries the booking's id in its address.
        referrerPolicy="strict-origin-when-cross-origin"
        src={src}
      />
    );
  }
  return (
    <div className={`${className} flex flex-col items-center justify-center gap-3 p-6 text-center`}>
      <p className="max-w-xs text-sm text-[color:var(--st-ink-70)]">
        This map comes from Google Maps. Showing it lets Google set cookies on your device.
      </p>
      <button
        type="button"
        onClick={() => recordShopConsent("granted")}
        className="min-h-11 rounded-[var(--st-r-md)] border border-[color:var(--st-accent-40)] px-5 text-sm font-medium text-[color:var(--st-accent-text)] transition-colors hover:bg-[color:var(--st-accent-10)]"
      >
        Show map
      </button>
    </div>
  );
}
