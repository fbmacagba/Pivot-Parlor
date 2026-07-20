import { Link } from "@remix-run/react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { formatPrice, isGenericCategory, sectionPadY } from "~/components/site/sections/bits";

/** Services "rows": the barbershop wall price list — name, dotted leader,
 *  price — with booking one tap away. */
export function ServicesRowsSection({
  ctx,
  density,
  glow,
}: {
  ctx: SiteRenderContext;
  density: Density;
  glow: boolean;
}) {
  return (
    <section id="services" className={`relative scroll-mt-24 overflow-hidden px-4 md:px-6 ${sectionPadY(density)}`}>
      {glow && (
        <div className="pointer-events-none absolute -right-32 top-8 h-72 w-72 rounded-full bg-[color:var(--st-accent-07)] blur-3xl" aria-hidden />
      )}
      <div className="relative mx-auto max-w-4xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Services</h2>
        <p className="mt-2 max-w-2xl text-[color:var(--st-ink-60)]">Choose a treatment and book in a few clicks.</p>

        {ctx.categories.length > 1 && (
          <div className="mt-8 flex flex-wrap gap-2">
            {ctx.categories.map((c) => (
              <button key={c} type="button" onClick={() => ctx.setCategory(c)}
                className={`min-h-12 rounded-full px-5 text-sm font-medium transition ${
                  ctx.category === c
                    ? "bg-[color:var(--color-accent)] text-[color:var(--st-on-accent)]"
                    : "border border-[color:var(--st-line-20)] text-[color:var(--st-ink-80)] hover:border-[color:var(--color-accent)]"
                }`}>
                {c}
              </button>
            ))}
          </div>
        )}

        <ul className="mt-10 divide-y divide-[color:var(--st-line-10)] border-y border-[color:var(--st-line-10)]">
          {ctx.filteredServices.length === 0
            ? [0, 1, 2].map((i) => (
                <li key={`placeholder-${i}`} className="py-6">
                  <div className="h-6 w-2/3 animate-pulse rounded bg-[color:var(--st-chip)]" />
                  <div className="mt-3 h-4 w-1/3 animate-pulse rounded bg-[color:var(--st-chip)]" />
                </li>
              ))
            : ctx.filteredServices.map((svc) => (
                <li key={svc.id} className={density === "compact" ? "py-4" : "py-6"}>
                  <div className="flex items-baseline gap-3">
                    <h3 className="pp-heading text-lg font-semibold leading-snug text-[color:var(--st-ink)] md:text-xl">{svc.name}</h3>
                    <span className="hidden min-w-8 flex-1 self-center border-b border-dotted border-[color:var(--st-line-20)] sm:block" aria-hidden />
                    <span className="pp-heading shrink-0 text-xl font-bold text-[color:var(--st-accent-text)] md:text-2xl">£{formatPrice(svc.price_gbp)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 text-sm text-[color:var(--st-ink-55)]">
                      <span className="tabular-nums">{svc.duration_minutes} min</span>
                      {!isGenericCategory(svc.category) ? <span> · {svc.category}</span> : null}
                      {svc.description ? <span className="hidden md:inline"> · {svc.description}</span> : null}
                    </p>
                    <Link to={`/${ctx.shopSlug}/book?serviceId=${encodeURIComponent(svc.id)}`}
                      className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-[var(--st-r-sm)] border border-[color:var(--color-accent)] px-5 pp-heading text-sm font-semibold text-[color:var(--st-accent-text)] transition hover:bg-[color:var(--st-accent-10)]">
                      Book <span aria-hidden>→</span>
                    </Link>
                  </div>
                </li>
              ))}
        </ul>
      </div>
    </section>
  );
}
