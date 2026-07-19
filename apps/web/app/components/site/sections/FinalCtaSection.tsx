import { Link } from "@remix-run/react";
import type { SiteRenderContext } from "~/components/site/sectionContext";

export function FinalCtaSection({ ctx, glow }: { ctx: SiteRenderContext; glow: boolean }) {
  return (
    <section className="relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-accent-10)] px-4 py-20 md:px-6 md:py-28">
      {glow && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-[44rem] max-w-full -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--st-accent-15)] blur-3xl" aria-hidden />
      )}
      <div className="relative mx-auto max-w-3xl text-center">
        <h2 className="pp-heading text-[clamp(1.85rem,4.5vw,3rem)] font-bold leading-tight text-[color:var(--st-ink)]">{ctx.archetype.ctaHeading}</h2>
        <p className="mt-4 text-lg text-[color:var(--st-ink-70)]">{ctx.archetype.ctaSub}</p>
        <Link to={`/${ctx.shopSlug}/book`}
          className="mt-10 inline-flex min-h-14 min-w-[14rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-12 pp-heading text-lg font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-accent-25)] transition hover:brightness-110">
          {ctx.bookLabel} →
        </Link>
        <p className="mt-6 text-sm text-[color:var(--st-ink-55)]">Book in under a minute · No account needed</p>
      </div>
    </section>
  );
}
