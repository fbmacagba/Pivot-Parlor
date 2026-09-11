import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor } from "~/components/site/sections/bits";

/** Hero "minimal": no imagery at all — restraint is the statement. A faint
 *  accent wash, big type, one primary action and a quiet text link. */
export function HeroMinimalSection({
  ctx,
  density,
  motif,
  motionClass,
}: {
  ctx: SiteRenderContext;
  density: Density;
  motif: Motif;
  motionClass: string;
}) {
  const pad = density === "compact" ? "py-24 md:py-28" : "py-28 md:py-36";
  return (
    <section data-pp-hero="" className={`relative flex min-h-[85vh] flex-col items-center justify-center overflow-hidden px-4 md:px-6 ${pad}${motionClass ? ` ${motionClass}` : ""}`}>
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[36rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--st-accent-07)] blur-3xl" aria-hidden />
      {motif !== "line" ? <MotifDecor motif={motif} className="right-[12%] top-[18%]" /> : null}
      <div className="relative mx-auto w-full max-w-3xl text-center">
        {motif === "line" ? <MotifDecor motif="line" className="mx-auto mb-10 w-fit" /> : null}
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-ink-55)]">{ctx.heroSubline}</p>
        <h1 className="mt-6 text-[clamp(2.75rem,7vw,5rem)] font-bold leading-[1.02] tracking-tight text-[color:var(--st-ink)]">
          {ctx.heroHeadline}
        </h1>
        {ctx.heroTagline ? (
          <h2 className="mx-auto mt-6 max-w-xl text-[clamp(1.05rem,2.2vw,1.3rem)] font-light leading-relaxed text-[color:var(--st-ink-70)]">
            {ctx.heroTagline}
          </h2>
        ) : null}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-5">
          <Link to={`/${ctx.shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-shadow-25)] transition hover:brightness-110">
            {ctx.bookLabel} →
          </Link>
          <button type="button" onClick={() => ctx.scrollToId("services")}
            className="inline-flex min-h-11 items-center pp-heading text-base font-semibold text-[color:var(--st-ink-80)] underline decoration-[color:var(--st-accent-40)] underline-offset-8 transition hover:text-[color:var(--st-accent-text)]">
            See Our Services
          </button>
        </div>
        <p className="mt-10 text-sm text-[color:var(--st-ink-55)]">Book in under a minute · No account needed</p>
      </div>
    </section>
  );
}
