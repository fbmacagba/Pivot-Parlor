import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow, formatReviewDate } from "~/components/site/sections/bits";

export function ReviewsSection({ ctx }: { ctx: SiteRenderContext }) {
  if (ctx.sortedReviews.length === 0) return null;
  return (
    <section className="px-4 py-16 md:px-6 md:py-24">
      <div className="mx-auto max-w-7xl">
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Reviews</h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {ctx.sortedReviews.map((r) => (
            <blockquote key={r.id} className="rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-6">
              <StarRow rating={r.rating} className="text-base" />
              <p className="mt-3 text-[color:var(--st-ink-90)]">&ldquo;{r.body}&rdquo;</p>
              <footer className="mt-4 flex items-center justify-between text-sm text-[color:var(--st-ink-50)]">
                <cite className="not-italic font-medium text-[color:var(--st-ink-70)]">{r.customer_name}</cite>
                <span>{formatReviewDate(r.created_at)}</span>
              </footer>
            </blockquote>
          ))}
        </div>
      </div>
    </section>
  );
}
