import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { HoursTable, sectionPadY } from "~/components/site/sections/bits";

/** Location "map-first": the map leads full-width; details sit beneath it. */
export function LocationMapFirstSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  if (!ctx.hasAddress) return null;
  return (
    <section className={`border-t border-[color:var(--st-line-10)] px-4 md:px-6 ${sectionPadY(density)}`}>
      <div className="mx-auto max-w-7xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Find us</h2>
        <div className="mt-8 h-[320px] overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] md:h-[400px]">
          {ctx.settings.lat != null && ctx.settings.lng != null ? (
            <iframe
              title="Map"
              className="h-full w-full border-0"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              src={`https://www.google.com/maps?q=${ctx.settings.lat}%2C${ctx.settings.lng}&z=15&output=embed`}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-[color:var(--st-ink-60)]">{ctx.settings.address}</div>
          )}
        </div>
        <div className="mt-10 grid gap-10 md:grid-cols-2">
          <div>
            {ctx.settings.phone ? (
              <p className="text-lg">
                <a href={`tel:${ctx.settings.phone.replace(/\s/g, "")}`} className="text-[color:var(--st-accent-text)]">{ctx.settings.phone}</a>
              </p>
            ) : null}
            <p className="mt-2 text-[color:var(--st-ink-70)]">{ctx.settings.address}</p>
          </div>
          <HoursTable hoursJson={ctx.settings.hours_json} />
        </div>
      </div>
    </section>
  );
}
