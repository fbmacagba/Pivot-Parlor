import type { SiteRenderContext } from "~/components/site/sectionContext";
import { ContactLines, DirectionsLink, VisitHours, canMap, mapEmbedSrc } from "~/components/site/sections/VisitDetails";

/** Location and hours. Renders for any of address, hours or phone (it used to
 *  need an address, so hours alone never showed); the map and directions
 *  appear only for a real, mappable address. */
export function LocationSection({ ctx }: { ctx: SiteRenderContext }) {
  if (!ctx.hasVisitInfo) return null;
  const heading = ctx.hasAddress ? "Location & hours" : "Opening hours";
  if (!canMap(ctx)) {
    return (
      <section className="border-t border-[color:var(--st-line-10)] px-4 py-16 md:px-6 md:py-24">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
          <div>
            <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">{heading}</h2>
            <div className="mt-4">
              <ContactLines ctx={ctx} />
            </div>
          </div>
          <div className="lg:pt-2">
            <VisitHours ctx={ctx} />
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="border-t border-[color:var(--st-line-10)] px-4 py-16 md:px-6 md:py-24">
      <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
        <div>
          <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">{heading}</h2>
          <div className="mt-4">
            <ContactLines ctx={ctx} />
          </div>
          <div className="mt-8">
            <VisitHours ctx={ctx} />
          </div>
        </div>
        <div className="flex flex-col">
          <div className="min-h-[280px] flex-1 overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)]">
            <iframe title={`Map showing ${ctx.site.shop_name}`} className="h-full min-h-[280px] w-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade"
              src={mapEmbedSrc(ctx)} />
          </div>
          <DirectionsLink ctx={ctx} className="mt-4 self-start" />
        </div>
      </div>
    </section>
  );
}
