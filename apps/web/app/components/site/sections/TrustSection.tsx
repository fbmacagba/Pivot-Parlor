import type { SiteRenderContext } from "~/components/site/sectionContext";

/** The trust strip states only what the shop's records back: its factual
 *  signals, plus the real average of its own published reviews when it has
 *  any. (It used to add "N happy clients" rounded up to a floor of 10 and a
 *  stock "Instant confirmation · Same-day slots" line.) */
export function TrustSection({ ctx }: { ctx: SiteRenderContext }) {
  const reviews = ctx.hasSocialProof
    ? `${ctx.statsRating}★ average from ${ctx.reviewCount} review${ctx.reviewCount === 1 ? "" : "s"}`
    : null;
  const signals = ctx.trustSignals.length > 0 ? ctx.trustSignals : ["Book online, any time", "No account needed to book"];
  return (
    <section id="stats-bar" className="scroll-mt-24 border-y border-[color:var(--st-line-10)] bg-[color:var(--st-card-faint)] py-6">
      <ul className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-8 gap-y-2 px-4 text-center text-sm text-[color:var(--st-ink-70)] md:px-6 md:text-base">
        {reviews ? <li className="font-semibold text-[color:var(--st-accent-text)]">{reviews}</li> : null}
        {signals.map((s, i) => (
          <li key={`${s}-${i}`}>{s}</li>
        ))}
      </ul>
    </section>
  );
}
