import { Link } from "@remix-run/react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { sectionPadY } from "~/components/site/sections/bits";

/** Team "strip": a snap-scrolling rail of compact cards — browsable with one
 *  thumb, at home on mobile. */
export function TeamStripSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  if (ctx.staff.length === 0) return null;
  return (
    <section className={`border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-1)] ${sectionPadY(density)}`}>
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Meet the team</h2>
          {ctx.staff.length > 3 ? <p className="text-sm text-[color:var(--st-ink-50)]">Scroll for more</p> : null}
        </div>
      </div>
      <ul className="mt-10 flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pb-4 md:px-6 lg:px-[max(1.5rem,calc((100vw-80rem)/2))]">
        {ctx.staff.map((m) => {
          const initials = m.display_name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
          return (
            <li key={m.id} className="w-72 shrink-0 snap-start rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[color:var(--st-accent-25)] text-lg font-bold text-[color:var(--st-accent-text)]">
                  {m.avatar_url ? (
                    <img src={m.avatar_url} alt={`Photo of ${m.display_name}`} className="h-full w-full object-cover" />
                  ) : (
                    initials
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="pp-heading truncate text-lg font-semibold text-[color:var(--st-ink)]">{m.display_name}</h3>
                  {m.speciality ? <p className="truncate text-sm text-[color:var(--st-accent-text)]">{m.speciality}</p> : null}
                </div>
              </div>
              {m.bio ? <p className="mt-4 text-sm text-[color:var(--st-ink-55)] line-clamp-3">{m.bio}</p> : null}
              <Link
                to={`/${ctx.shopSlug}/book?staffId=${encodeURIComponent(m.id)}`}
                className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-[var(--st-r-sm)] border border-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--st-accent-text)] transition hover:bg-[color:var(--st-accent-10)]"
              >
                Book with {m.display_name.trim().split(/\s+/)[0]}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
