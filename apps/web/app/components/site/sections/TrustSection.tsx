import type { SiteRenderContext } from "~/components/site/sectionContext";

export function TrustSection({ ctx }: { ctx: SiteRenderContext }) {
  return (
    <section id="stats-bar" className="scroll-mt-24 border-y border-[color:var(--st-line-10)] bg-[color:var(--st-card-faint)] py-6">
      <div className="mx-auto max-w-7xl px-4 text-center text-sm text-[color:var(--st-ink-70)] md:px-6 md:text-base">
        {ctx.hasSocialProof ? (
          <>
            <span className="font-semibold text-[color:var(--st-accent-text)]">{ctx.statsRating}★</span>
            {" "}average · {ctx.statsHappy} happy clients · {ctx.trustSignals.length > 0 ? ctx.trustSignals.join(" · ") : "Same-day slots when available"}
          </>
        ) : (
          <>{ctx.trustSignals.length > 0 ? ctx.trustSignals.join(" · ") : "Online booking · Instant confirmation · Same-day slots when available"}</>
        )}
      </div>
    </section>
  );
}
