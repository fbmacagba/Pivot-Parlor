import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor, StarRow } from "~/components/site/sections/bits";
import { useParallax } from "~/components/site/motion/useParallax";

/** Hero "split": copy on the page surface beside a full-height image column,
 *  like a shopfront window next to the sign. Ink tokens, not white-on-scrim,
 *  so light palettes finally get a light hero. */
export function HeroSplitSection({
  ctx,
  density,
  motif,
  motionClass,
  parallax,
}: {
  ctx: SiteRenderContext;
  density: Density;
  motif: Motif;
  motionClass: string;
  parallax: boolean;
}) {
  const imgRef = useParallax<HTMLImageElement>(parallax, 14, "scale(1.05)");
  const pad = density === "compact" ? "py-14 md:py-16" : "py-20 md:py-24";
  return (
    <section data-pp-hero="" className={`relative overflow-hidden${motionClass ? ` ${motionClass}` : ""}`}>
      <div className="grid w-full lg:grid-cols-2">
        <div className={`relative mx-auto flex w-full max-w-2xl flex-col justify-center px-4 ${pad} md:px-6 lg:min-h-screen lg:pl-[max(1.5rem,calc((100vw-80rem)/2))] lg:pr-16`}>
          {motif === "line" ? <MotifDecor motif="line" className="mb-6 w-fit" /> : <MotifDecor motif={motif} className="-left-10 bottom-8 opacity-70" />}
          <div className="inline-flex min-h-11 w-fit items-center gap-2 rounded-full border border-[color:var(--st-line-20)] bg-[color:var(--st-card-faint)] px-4 py-2 text-sm text-[color:var(--st-ink-90)]">
            {ctx.hasSocialProof ? (
              <>
                <StarRow rating={Number(ctx.statsRating)} className="text-sm" />
                <span>{ctx.statsRating}★ from {ctx.reviewCount} review{ctx.reviewCount === 1 ? "" : "s"}</span>
              </>
            ) : (
              <>
                <span className="text-[color:var(--st-accent-text)]" aria-hidden>✓</span>
                <span>Online booking, any time</span>
              </>
            )}
          </div>
          <h1 className="mt-8 text-[clamp(2.5rem,5vw,4.25rem)] font-bold leading-[1.05] tracking-[-0.02em] text-[color:var(--st-ink)] [text-wrap:balance]">
            {ctx.heroHeadline}
          </h1>
          {ctx.heroTagline ? (
            <p className="mt-4 max-w-xl text-[clamp(1.05rem,2vw,1.3rem)] font-light leading-relaxed text-[color:var(--st-ink-70)]">
              {ctx.heroTagline}
            </p>
          ) : null}
          <div className="mt-10 flex flex-wrap gap-4">
            <Link to={`/${ctx.shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-shadow-25)] transition hover:brightness-110 active:scale-[0.98]">
              {ctx.bookLabel}<span aria-hidden>&nbsp;→</span>
            </Link>
            <button type="button" onClick={() => ctx.scrollToId("services")}
              className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] border-2 border-[color:var(--st-line-40)] bg-transparent px-8 pp-heading text-base font-semibold text-[color:var(--st-ink)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--st-accent-text)]">
              View services
            </button>
          </div>
          <p className="mt-8 text-sm text-[color:var(--st-ink-55)]">{ctx.heroSubline}</p>
        </div>
        <div className="relative min-h-[42vh] overflow-hidden lg:min-h-screen">
          {ctx.heroSrc ? (
            <>
              <img
                ref={imgRef}
                src={ctx.heroSrc}
                alt={`${ctx.site.shop_name} hero photo`}
                className="absolute inset-0 h-full w-full scale-105 object-cover"
                loading="eager"
                decoding="async"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[color:var(--st-bg)] via-transparent to-transparent lg:bg-gradient-to-r" aria-hidden />
            </>
          ) : (
            <div className="h-full min-h-[42vh] w-full lg:min-h-screen" style={{ background: "linear-gradient(145deg, var(--color-brand) 0%, var(--st-bg) 60%, var(--color-accent) 170%)" }} aria-hidden />
          )}
        </div>
      </div>
    </section>
  );
}
