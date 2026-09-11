import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor } from "~/components/site/sections/bits";
import { useParallax } from "~/components/site/motion/useParallax";

/** Hero "editorial": a magazine opener — oversized centred display type on
 *  the page surface, the trust line as an eyebrow, and the image as a wide
 *  band BELOW the headline instead of behind it. */
export function HeroEditorialSection({
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
  const imgRef = useParallax<HTMLImageElement>(parallax, 10, "scale(1.05)");
  const pad = density === "compact" ? "pt-16 pb-12 md:pt-20 md:pb-16" : "pt-20 pb-16 md:pt-28 md:pb-24";
  return (
    <section data-pp-hero="" className={`relative overflow-hidden px-4 md:px-6 ${pad}${motionClass ? ` ${motionClass}` : ""}`}>
      {motif !== "line" ? <MotifDecor motif={motif} className="-right-10 top-16" /> : null}
      <div className="relative mx-auto w-full max-w-5xl text-center">
        {motif === "line" ? <MotifDecor motif="line" className="mx-auto mb-8 w-fit" /> : null}
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-accent-text)]">
          {ctx.heroSubline}
        </p>
        <h1 className="mx-auto mt-6 max-w-4xl text-[clamp(2.75rem,8vw,5.5rem)] font-bold leading-[0.98] tracking-tight text-[color:var(--st-ink)]">
          {ctx.heroHeadline}
        </h1>
        {ctx.heroTagline ? (
          <h2 className="mx-auto mt-6 max-w-2xl text-[clamp(1.05rem,2.2vw,1.35rem)] font-light leading-relaxed text-[color:var(--st-ink-70)]">
            {ctx.heroTagline}
          </h2>
        ) : null}
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link to={`/${ctx.shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-shadow-25)] transition hover:brightness-110">
            {ctx.bookLabel} →
          </Link>
          <button type="button" onClick={() => ctx.scrollToId("services")}
            className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] border-2 border-[color:var(--st-line-40)] bg-transparent px-8 pp-heading text-base font-semibold text-[color:var(--st-ink)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--st-accent-text)]">
            See Our Services
          </button>
        </div>
      </div>
      {ctx.heroSrc ? (
        <div className="relative mx-auto mt-14 aspect-[21/9] w-full max-w-6xl overflow-hidden rounded-[var(--st-r-lg)]">
          <img
            ref={imgRef}
            src={ctx.heroSrc}
            alt={`${ctx.site.shop_name} hero photo`}
            className="absolute inset-0 h-full w-full scale-105 object-cover"
            loading="eager"
            decoding="async"
          />
        </div>
      ) : null}
    </section>
  );
}
