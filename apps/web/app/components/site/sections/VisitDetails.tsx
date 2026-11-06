import { googleMapsEmbedUrl, googleMapsUrl } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { HoursTable, hasOpenDay } from "~/components/site/sections/bits";

/** A map only for a real address: a demo's illustrative address must never
 *  point a visitor at a real place. */
export function canMap(ctx: SiteRenderContext): boolean {
  return ctx.hasAddress && !ctx.illustrativeContact;
}

export function mapEmbedSrc(ctx: SiteRenderContext): string {
  const address = ctx.settings.address ?? "";
  return ctx.settings.lat != null && ctx.settings.lng != null
    ? `https://www.google.com/maps?q=${ctx.settings.lat}%2C${ctx.settings.lng}&z=15&output=embed`
    : googleMapsEmbedUrl(address);
}

export function DirectionsLink({ ctx, className = "" }: { ctx: SiteRenderContext; className?: string }) {
  if (!canMap(ctx)) return null;
  return (
    <a
      href={googleMapsUrl(ctx.settings.address ?? "")}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-11 items-center justify-center rounded-[var(--st-r-md)] border border-[color:var(--st-accent-40)] px-5 text-sm font-medium text-[color:var(--st-accent-text)] transition-colors hover:bg-[color:var(--st-accent-10)] ${className}`}
    >
      Get directions
    </a>
  );
}

/** Phone, address and opening hours, each only when the shop has it. */
export function ContactLines({ ctx }: { ctx: SiteRenderContext }) {
  const phone = ctx.settings.phone?.trim();
  const address = ctx.settings.address?.trim();
  const illustrative = ctx.illustrativeContact;
  return (
    <>
      {phone ? (
        <p className="text-lg">
          {illustrative ? (
            <span className="inline-flex min-h-11 items-center text-[color:var(--st-ink)] tabular-nums">{phone}</span>
          ) : (
            <a href={`tel:${phone.replace(/\s/g, "")}`} className="inline-flex min-h-11 items-center text-[color:var(--st-accent-text)] tabular-nums underline-offset-4 hover:underline">
              {phone}
            </a>
          )}
        </p>
      ) : null}
      {address ? <p className="mt-1 text-[color:var(--st-ink-70)]">{address}</p> : null}
      {illustrative && (phone || address) ? (
        <p className="mt-3 text-sm text-[color:var(--st-ink-55)]">
          Illustrative contact details for this fictional demo shop.
        </p>
      ) : null}
    </>
  );
}

export function VisitHours({ ctx }: { ctx: SiteRenderContext }) {
  return hasOpenDay(ctx.settings.hours_json) ? <HoursTable hoursJson={ctx.settings.hours_json} /> : null;
}
