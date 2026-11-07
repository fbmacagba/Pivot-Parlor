import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { sectionPadY } from "~/components/site/sections/bits";
import { ContactLines, DirectionsLink, VisitHours, canMap, mapEmbedSrc } from "~/components/site/sections/VisitDetails";

/** Location "map-first": the map leads full-width; details sit beneath it.
 *  Without a real, mappable address the details lead on their own. */
export function LocationMapFirstSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  if (!ctx.hasVisitInfo) return null;
  const mapped = canMap(ctx);
  return (
    <section className={`border-t border-[color:var(--st-line-10)] px-4 md:px-6 ${sectionPadY(density)}`}>
      <div className="mx-auto max-w-7xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">
          {ctx.hasAddress ? "Find us" : "Opening hours"}
        </h2>
        {mapped ? (
          <>
            <div className="mt-8 h-[320px] overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] md:h-[400px]">
              <iframe
                title={`Map showing ${ctx.site.shop_name}`}
                className="h-full w-full border-0"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                src={mapEmbedSrc(ctx)}
              />
            </div>
            <DirectionsLink ctx={ctx} className="mt-4" />
          </>
        ) : null}
        <div className={`${mapped ? "mt-10" : "mt-8"} grid gap-10 md:grid-cols-2`}>
          <div>
            <ContactLines ctx={ctx} />
          </div>
          <VisitHours ctx={ctx} />
        </div>
      </div>
    </section>
  );
}
