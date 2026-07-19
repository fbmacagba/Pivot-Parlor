import { Link } from "@remix-run/react";
import type { SiteRenderContext } from "~/components/site/sectionContext";

export function TeamSection({ ctx }: { ctx: SiteRenderContext }) {
  if (ctx.staff.length === 0) return null;
  return (
    <section className="border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-1)] px-4 py-16 md:px-6 md:py-24">
      <div className="mx-auto max-w-7xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Meet the team</h2>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {ctx.staff.map((m) => {
            const initials = m.display_name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
            return (
              <article key={m.id} className="flex flex-col rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-5 text-center">
                <div className="mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-[color:var(--st-accent-25)] text-xl font-bold text-[color:var(--st-accent-text)]">
                  {m.avatar_url ? (
                    <img
                      src={m.avatar_url}
                      alt={`Photo of ${m.display_name}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    initials
                  )}
                </div>
                <h3 className="mt-4 pp-heading text-lg font-semibold">{m.display_name}</h3>
                {m.speciality && <p className="text-sm text-[color:var(--st-accent-text)]">{m.speciality}</p>}
                {m.bio && <p className="mt-3 text-sm text-[color:var(--st-ink-55)] line-clamp-4">{m.bio}</p>}
                <Link to={`/${ctx.shopSlug}/book?staffId=${encodeURIComponent(m.id)}`}
                  className="mt-5 inline-flex min-h-12 items-center justify-center rounded-[var(--st-r-sm)] border border-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--st-accent-text)]">
                  Book with {m.display_name.split(" ")[0]}
                </Link>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
