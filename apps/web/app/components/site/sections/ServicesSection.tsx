import { Link } from "@remix-run/react";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { formatPrice, isGenericCategory } from "~/components/site/sections/bits";

export function ServicesSection({
  ctx,
  cols,
  glow,
}: {
  ctx: SiteRenderContext;
  cols: 2 | 3;
  glow: boolean;
}) {
  const servicesColsClass = cols === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3";
  return (
    <section id="services" className="relative scroll-mt-24 overflow-hidden px-4 py-16 md:px-6 md:py-24">
      {glow && (
        <div className="pointer-events-none absolute -right-32 top-8 h-72 w-72 rounded-full bg-[color:var(--st-accent-07)] blur-3xl" aria-hidden />
      )}
      <div className="relative mx-auto max-w-7xl">
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

        <div className={`mt-10 grid gap-6 sm:grid-cols-2 ${servicesColsClass}`}>
          {ctx.services.length === 0
            ? [0, 1, 2].map((i) => (
                <article key={`placeholder-${i}`} className="group flex flex-col overflow-hidden rounded-[var(--st-r-lg)] border border-dashed border-[color:var(--st-line-20)] bg-[color:var(--st-card-faint)] shadow-xl shadow-[color:var(--st-shadow-20)]">
                  <div className="relative aspect-[4/3] overflow-hidden bg-[color:var(--st-accent-15)]">
                    <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-[color:var(--st-accent-25)] to-transparent opacity-70" />
                  </div>
                  <div className="flex flex-1 flex-col p-6">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--st-accent-text)]">Coming soon</p>
                    <div className="mt-3 h-6 w-3/4 animate-pulse rounded bg-[color:var(--st-chip)]" />
                    <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-[color:var(--st-chip)]" />
                    <div className="mt-4 h-12 w-full animate-pulse rounded-[var(--st-r-sm)] bg-[color:var(--st-chip)]" />
                  </div>
                </article>
              ))
            : ctx.filteredServices.map((svc) => {
                // Only show a real photo; otherwise a short accent header band gives
                // the card mass so it reads as an intentional menu item.
                const hasImage = typeof svc.image_url === "string" && svc.image_url.trim().length > 0;
                // Hide the generic auto-assigned "Service" category; keep real ones
                // (mirrors the filter-chip exclusion above).
                const showCategory = !isGenericCategory(svc.category);
                return (
                  <article key={svc.id} className="group relative flex flex-col overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card)] shadow-xl shadow-[color:var(--st-shadow-25)] transition duration-300 hover:-translate-y-0.5 hover:border-[color:var(--st-accent-40)] hover:bg-[color:var(--st-card-hover)]">
                    {hasImage ? (
                      <div className="relative aspect-[16/10] overflow-hidden">
                        <img
                          src={svc.image_url}
                          alt={svc.name}
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
                        />
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 to-transparent" aria-hidden />
                      </div>
                    ) : (
                      <div className="aspect-[16/5] w-full bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
                    )}
                    <div className="flex flex-1 flex-col p-6">
                      {showCategory && (
                        <p className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[color:var(--st-accent-text)]">{svc.category}</p>
                      )}
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="pp-heading text-xl font-semibold leading-snug text-[color:var(--st-ink)]">{svc.name}</h3>
                        <span className="pp-heading shrink-0 text-2xl font-bold leading-none text-[color:var(--st-accent-text)]">£{formatPrice(svc.price_gbp)}</span>
                      </div>
                      <p className="mt-2 text-sm text-[color:var(--st-ink-55)] tabular-nums">{svc.duration_minutes} min</p>
                      {svc.description ? (
                        <p className="mt-3 flex-1 text-sm leading-relaxed text-[color:var(--st-ink-55)] line-clamp-2">{svc.description}</p>
                      ) : (
                        <div className="flex-1" aria-hidden />
                      )}
                      <Link to={`/${ctx.shopSlug}/book?serviceId=${encodeURIComponent(svc.id)}`}
                        className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-4 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition hover:brightness-110 active:scale-[0.98]">
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
