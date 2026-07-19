import { Link } from "@remix-run/react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { formatPrice, isGenericCategory, sectionPadY } from "~/components/site/sections/bits";

/** Services "showcase": editorial full-width cards, image and copy side by
 *  side, alternating direction — for shops whose imagery carries the sell. */
export function ServicesShowcaseSection({
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
      <div className="relative mx-auto max-w-6xl">
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

        <div className={`mt-10 flex flex-col ${density === "compact" ? "gap-8" : "gap-12"}`}>
          {ctx.filteredServices.length === 0
            ? [0, 1].map((i) => (
                <article key={`placeholder-${i}`} className="grid gap-6 overflow-hidden rounded-[var(--st-r-lg)] border border-dashed border-[color:var(--st-line-20)] bg-[color:var(--st-card-faint)] md:grid-cols-2 md:gap-0">
                  <div className="aspect-[16/10] animate-pulse bg-[color:var(--st-accent-15)] md:aspect-auto md:min-h-[18rem]" />
                  <div className="flex flex-col p-6 md:p-10">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--st-accent-text)]">Coming soon</p>
                    <div className="mt-3 h-7 w-2/3 animate-pulse rounded bg-[color:var(--st-chip)]" />
                    <div className="mt-4 h-4 w-1/2 animate-pulse rounded bg-[color:var(--st-chip)]" />
                  </div>
                </article>
              ))
            : ctx.filteredServices.map((svc, i) => {
                const hasImage = typeof svc.image_url === "string" && svc.image_url.trim().length > 0;
                return (
                  <article key={svc.id} className="grid items-stretch gap-0 overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card)] md:grid-cols-2">
                    <div className={`relative aspect-[16/10] md:aspect-auto md:min-h-[18rem]${i % 2 === 1 ? " md:order-2" : ""}`}>
                      {hasImage ? (
                        <img src={svc.image_url} alt={svc.name} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
                      )}
                    </div>
                    <div className="flex flex-col p-6 md:p-10">
                      {!isGenericCategory(svc.category) && (
                        <p className="mb-2 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[color:var(--st-accent-text)]">{svc.category}</p>
                      )}
                      <h3 className="pp-heading text-2xl font-semibold text-[color:var(--st-ink)] md:text-3xl">{svc.name}</h3>
                      {svc.description ? (
                        <p className="mt-3 text-sm leading-relaxed text-[color:var(--st-ink-55)] md:text-base">{svc.description}</p>
                      ) : null}
                      <p className="mt-4 text-sm text-[color:var(--st-ink-55)]">
                        <span className="pp-heading text-2xl font-bold text-[color:var(--st-accent-text)]">£{formatPrice(svc.price_gbp)}</span>
                        <span className="tabular-nums"> · {svc.duration_minutes} min</span>
                      </p>
                      <Link to={`/${ctx.shopSlug}/book?serviceId=${encodeURIComponent(svc.id)}`}
                        className="mt-6 inline-flex min-h-12 w-fit items-center justify-center gap-1.5 rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-6 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition hover:brightness-110">
                        Book this <span aria-hidden>→</span>
                      </Link>
                    </div>
                  </article>
                );
              })}
        </div>
      </div>
    </section>
  );
}
