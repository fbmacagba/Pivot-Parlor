import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow, formatReviewDate, sectionPadY } from "~/components/site/sections/bits";

/** Reviews "spotlight": one voice leads — the strongest quote set large —
 *  with the rest in a quiet grid beneath. */
export function ReviewsSpotlightSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  if (ctx.sortedReviews.length === 0) return null;
  const [featured, ...rest] = [...ctx.sortedReviews].sort(
    (a, b) => b.rating - a.rating || b.body.length - a.body.length,
  );
  return (
    <section className={`relative overflow-hidden px-4 md:px-6 ${sectionPadY(density)}`}>
      <div className="mx-auto max-w-7xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Reviews</h2>
        <figure className="relative mx-auto mt-12 max-w-3xl text-center">
          <span className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 pp-heading text-[8rem] leading-none text-[color:var(--st-accent-10)]" aria-hidden>
            &ldquo;
          </span>
          <StarRow rating={featured!.rating} className="relative text-lg" />
          <blockquote className="relative mt-4 text-[clamp(1.25rem,2.6vw,1.75rem)] font-light leading-relaxed text-[color:var(--st-ink-90)]">
            &ldquo;{featured!.body}&rdquo;
          </blockquote>
          <figcaption className="mt-5 text-sm text-[color:var(--st-ink-60)]">
            <cite className="not-italic font-semibold text-[color:var(--st-ink-80)]">{featured!.customer_name}</cite>
            {" - "}
            {formatReviewDate(featured!.created_at)}
          </figcaption>
        </figure>
        {rest.length > 0 ? (
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {rest.slice(0, 4).map((r) => (
              <blockquote key={r.id} className="rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-5">
                <StarRow rating={r.rating} className="text-sm" />
                <p className="mt-2 text-sm text-[color:var(--st-ink-80)] line-clamp-4">&ldquo;{r.body}&rdquo;</p>
                <footer className="mt-3 text-xs text-[color:var(--st-ink-50)]">
                  <cite className="not-italic">{r.customer_name}</cite>
                </footer>
              </blockquote>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
