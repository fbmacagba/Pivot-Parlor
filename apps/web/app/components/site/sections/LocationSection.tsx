import type { SiteRenderContext } from "~/components/site/sectionContext";
import { HoursTable } from "~/components/site/sections/bits";

export function LocationSection({ ctx }: { ctx: SiteRenderContext }) {
  if (!ctx.hasAddress) return null;
  return (
    <section className="border-t border-[color:var(--st-line-10)] px-4 py-16 md:px-6 md:py-24">
      <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
        <div>
          <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Location &amp; hours</h2>
          {ctx.settings.phone && (
            <p className="mt-4 text-lg">
              <a href={`tel:${ctx.settings.phone.replace(/\s/g, "")}`} className="text-[color:var(--st-accent-text)]">{ctx.settings.phone}</a>
            </p>
          )}
          <p className="mt-2 text-[color:var(--st-ink-70)]">{ctx.settings.address}</p>
          <div className="mt-8"><HoursTable hoursJson={ctx.settings.hours_json} /></div>
        </div>
        <div className="min-h-[280px] overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)]">
          {ctx.settings.lat != null && ctx.settings.lng != null ? (
            <iframe title="Map" className="h-full min-h-[280px] w-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade"
              src={`https://www.google.com/maps?q=${ctx.settings.lat}%2C${ctx.settings.lng}&z=15&output=embed`} />
          ) : (
            <div className="flex h-full min-h-[280px] items-center justify-center p-6 text-center text-[color:var(--st-ink-60)]">{ctx.settings.address}</div>
          )}
        </div>
      </div>
    </section>
  );
}
