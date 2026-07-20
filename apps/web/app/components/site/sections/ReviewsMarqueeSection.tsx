import type { CSSProperties } from "react";
import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow, formatReviewDate, sectionPadY } from "~/components/site/sections/bits";

function MarqueeCard({ r }: { r: SiteRenderContext["sortedReviews"][number] }) {
  return (
    <blockquote className="w-80 shrink-0 rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-6">
      <StarRow rating={r.rating} className="text-base" />
      <p className="mt-3 text-[color:var(--st-ink-90)] line-clamp-4">&ldquo;{r.body}&rdquo;</p>
      <footer className="mt-4 flex items-center justify-between text-sm text-[color:var(--st-ink-50)]">
        <cite className="not-italic font-medium text-[color:var(--st-ink-70)]">{r.customer_name}</cite>
        <span>{formatReviewDate(r.created_at)}</span>
      </footer>
    </blockquote>
  );
}

/** Reviews "marquee": a slow self-scrolling rail of quotes; hover/focus
 *  pauses it, reduced-motion stops it (CSS), and motion-off renders a
 *  hand-scrollable rail instead. Doubles as the marquee-reviews signature. */
export function ReviewsMarqueeSection({
  ctx,
  density,
  animate,
  heading = "Reviews",
}: {
  ctx: SiteRenderContext;
  density: Density;
  animate: boolean;
  heading?: string;
}) {
  if (ctx.sortedReviews.length === 0) return null;
  const cards = ctx.sortedReviews.map((r) => <MarqueeCard key={r.id} r={r} />);
  return (
    <section className={`overflow-hidden ${sectionPadY(density)}`}>
      <h2 className="mx-auto max-w-7xl px-4 pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)] md:px-6">
        {heading}
      </h2>
      {animate ? (
        <div className="st-marquee mt-10">
          <div
            className="st-marquee-track flex w-max"
            style={{ "--st-marquee-dur": `${Math.max(30, ctx.sortedReviews.length * 8)}s` } as CSSProperties}
          >
            <div className="flex gap-6 pr-6">{cards}</div>
            <div className="flex gap-6 pr-6" aria-hidden>{cards}</div>
          </div>
        </div>
      ) : (
        <div className="mt-10 flex snap-x gap-6 overflow-x-auto px-4 pb-4 md:px-6">{cards}</div>
      )}
    </section>
  );
}
