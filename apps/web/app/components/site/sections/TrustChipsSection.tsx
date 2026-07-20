import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow } from "~/components/site/sections/bits";

/** Trust "chips": the signal band as tactile pill chips instead of one dot-
 *  separated line. Keeps the #stats-bar id — the hero scroll cue targets it. */
export function TrustChipsSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  const signals =
    ctx.trustSignals.length > 0
      ? ctx.trustSignals
      : ["Online booking", "Instant confirmation", "Same-day slots when available"];
  return (
    <section
      id="stats-bar"
      className={`scroll-mt-24 border-y border-[color:var(--st-line-10)] bg-[color:var(--st-card-faint)] ${density === "compact" ? "py-6" : "py-8"}`}
    >
      <ul className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-3 px-4 md:px-6">
        {ctx.hasSocialProof ? (
          <li className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-10)] px-5 text-sm font-semibold text-[color:var(--st-ink-90)]">
            <StarRow rating={typeof ctx.site.rating === "number" ? ctx.site.rating : 5} className="text-sm" />
            <span>
              {ctx.statsRating}★ from {ctx.reviewCount} review{ctx.reviewCount === 1 ? "" : "s"}
            </span>
          </li>
        ) : null}
        {signals.map((s, i) => (
          <li
            key={`${s}-${i}`}
            className="inline-flex min-h-11 items-center rounded-full border border-[color:var(--st-line-20)] bg-[color:var(--st-card)] px-5 text-sm font-medium text-[color:var(--st-ink-80)]"
          >
            {s}
          </li>
        ))}
      </ul>
    </section>
  );
}
