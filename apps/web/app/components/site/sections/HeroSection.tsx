import { Link } from "@remix-run/react";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { StarRow } from "~/components/site/sections/bits";
import { useParallax } from "~/components/site/motion/useParallax";
import { isPortfolioDemoShop } from "@repo/utils";

export function HeroSection({
  ctx,
  centered,
  minH,
  motionClass = "",
  parallax = false,
}: {
  ctx: SiteRenderContext;
  centered: boolean;
  minH: "screen" | "tall";
  motionClass?: string;
  parallax?: boolean;
}) {
  const imgRef = useParallax<HTMLImageElement>(parallax, 14, "scale(1.05)");
  const minHClass = minH === "tall" ? "min-h-[85vh]" : "min-h-screen";
  return (
    <section data-pp-hero="" className={`relative flex ${minHClass} flex-col overflow-hidden${motionClass ? ` ${motionClass}` : ""}`}>
      <div className="absolute inset-0 -z-0">
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
            <div className="absolute inset-0 bg-gradient-to-b from-black/85 via-black/65 to-black/90" aria-hidden />
            <div className="absolute inset-0 bg-gradient-to-r from-black/50 via-transparent to-black/40" aria-hidden />
          </>
        ) : (
          <>
            <div className="h-full w-full" style={{ background: "linear-gradient(145deg, var(--color-brand) 0%, #000 45%, var(--color-accent) 160%)" }} aria-hidden />
            <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/55 to-black/90" aria-hidden />
          </>
        )}
      </div>

      <div className={`relative z-10 flex ${minHClass} w-full flex-col justify-center px-4 pb-6 pt-7 md:px-6 md:pb-8 md:pt-8`}>
        <div className={`mx-auto w-full max-w-7xl translate-y-2 md:translate-y-4 lg:translate-y-[max(1rem,2vh)]${centered ? " text-center" : ""}`}>
          <div className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-black/35 px-4 py-2 text-sm text-white/95 backdrop-blur-md">
            {ctx.hasSocialProof ? (
              <>
                <StarRow rating={typeof ctx.site.rating === "number" ? ctx.site.rating : 5} className="text-sm" />
                <span>{ctx.statsRating}★ from {ctx.reviewCount} review{ctx.reviewCount === 1 ? "" : "s"}</span>
              </>
            ) : (
              <>
                <span className="text-[color:var(--color-accent)]" aria-hidden>✓</span>
                <span>{isPortfolioDemoShop(ctx.shopSlug) ? "Interactive booking demonstration" : "Online booking · Instant confirmation"}</span>
              </>
            )}
          </div>

          <h1 className={`mt-8 max-w-[700px] text-5xl font-bold leading-[1.08] tracking-tight text-white md:text-7xl${centered ? " mx-auto" : ""}`}>
            {ctx.heroHeadline}
          </h1>
          {ctx.heroTagline ? (
            <h2 className={`mt-4 max-w-2xl text-[clamp(1.05rem,2.5vw,1.35rem)] font-normal font-light leading-relaxed text-white/75${centered ? " mx-auto" : ""}`}>
              {ctx.heroTagline}
            </h2>
          ) : null}

          {/* Hero sits over a dark image scrim in both schemes, so its copy
              stays literal white — only accent-filled controls tokenize. */}
          <div className={`mt-10 flex flex-wrap gap-4${centered ? " justify-center" : ""}`}>
            <Link to={`/${ctx.shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-black/30 transition hover:brightness-110 active:scale-[0.98]">
              {ctx.bookLabel} →
            </Link>
            <button type="button" onClick={() => ctx.scrollToId("services")}
              className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] border-2 border-white/50 bg-transparent px-8 pp-heading text-base font-semibold text-white transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)]">
              See Our Services
            </button>
          </div>

          <p className="mt-8 text-sm text-white/55 md:text-base">
            {ctx.heroSubline}
          </p>
        </div>
      </div>

      <button type="button" className="absolute bottom-6 left-1/2 z-10 hidden -translate-x-1/2 md:block"
        aria-label="Scroll down" onClick={() => ctx.scrollToId("stats-bar")}>
        <span className="text-3xl text-white/60 transition hover:text-white/90">↓</span>
      </button>
    </section>
  );
}
