import { googleMapsEmbedUrl, googleMapsUrl } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { HoursTable } from "~/components/site/sections/bits";

export function LocationSection({ ctx }: { ctx: SiteRenderContext }) {
  if (!ctx.hasAddress) return null;
  const address = ctx.settings.address ?? "";
  const mapSrc =
    ctx.settings.lat != null && ctx.settings.lng != null
      ? `https://www.google.com/maps?q=${ctx.settings.lat}%2C${ctx.settings.lng}&z=15&output=embed`
      : googleMapsEmbedUrl(address);
  return (
    <section className="border-t border-[color:var(--st-line-10)] px-4 py-16 md:px-6 md:py-24">
      <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
        <div>
          <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Location &amp; hours</h2>
          {ctx.settings.phone && (
            <p className="mt-4 text-lg">
              <a href={`tel:${ctx.settings.phone.replace(/\s/g, "")}`} className="inline-flex min-h-11 items-center text-[color:var(--st-accent-text)]">{ctx.settings.phone}</a>
            </p>
          )}
          <p className="mt-2 text-[color:var(--st-ink-70)]">{address}</p>
          <div className="mt-8"><HoursTable hoursJson={ctx.settings.hours_json} /></div>
        </div>
        <div className="flex flex-col">
          <div className="min-h-[280px] flex-1 overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)]">
            <iframe title="Map" className="h-full min-h-[280px] w-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade"
              src={mapSrc} />
          </div>
          <a
            href={googleMapsUrl(address)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex min-h-11 items-center justify-center self-start rounded-[var(--st-r-md)] border border-[color:var(--st-accent-40)] px-5 text-sm font-medium text-[color:var(--st-accent-text)] transition-colors hover:bg-[color:var(--st-accent-10)]"
          >
            Get directions
          </a>
        </div>
      </div>
    </section>
  );
}
