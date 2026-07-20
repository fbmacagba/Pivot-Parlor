import { Link } from "@remix-run/react";
import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor, formatPrice, sectionPadY } from "~/components/site/sections/bits";
import { useCountUp } from "~/components/site/motion/useCountUp";
import { useParallax } from "~/components/site/motion/useParallax";

/** Signature "spotlight": the shop's headline treatment given a full stage —
 *  slow-drifting imagery, count-up stats (real numbers only), one focused
 *  call to book it. */
export function SignatureSpotlightSection({
  ctx,
  density,
  motif,
  animate,
}: {
  ctx: SiteRenderContext;
  density: Density;
  motif: Motif;
  animate: boolean;
}) {
  const featured =
    [...ctx.services]
      .sort((a, b) => b.price_gbp - a.price_gbp)
      .find((s) => typeof s.image_url === "string" && s.image_url.trim()) ?? ctx.services[0];
  const reviewsStat = useCountUp(ctx.reviewCount, animate);
  const servicesStat = useCountUp(ctx.services.length, animate);
  const imgRef = useParallax<HTMLImageElement>(animate, 12, "scale(1.05)");
  if (!featured) return null;
  const hasImage = typeof featured.image_url === "string" && featured.image_url.trim().length > 0;
  return (
    <section className={`relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-1)] px-4 md:px-6 ${sectionPadY(density)}`}>
      {motif !== "line" ? <MotifDecor motif={motif} className="-left-16 bottom-10" /> : null}
      <div className="relative mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className="relative aspect-[4/5] max-h-[560px] w-full overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)]">
          {hasImage ? (
            <img
              ref={imgRef}
              src={featured.image_url}
              alt={featured.name}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full scale-105 object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
          )}
        </div>
        <div>
          {motif === "line" ? <MotifDecor motif="line" className="mb-6 w-fit" /> : null}
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-accent-text)]">Signature service</p>
          <h2 className="mt-3 pp-heading text-[clamp(1.85rem,4.5vw,3rem)] font-bold leading-tight text-[color:var(--st-ink)]">{featured.name}</h2>
          {featured.description ? (
            <p className="mt-4 text-base leading-relaxed text-[color:var(--st-ink-70)] md:text-lg">{featured.description}</p>
          ) : null}
          <p className="mt-5 text-sm text-[color:var(--st-ink-55)]">
            <span className="pp-heading text-3xl font-bold text-[color:var(--st-accent-text)]">£{formatPrice(featured.price_gbp)}</span>
            <span className="tabular-nums"> · {featured.duration_minutes} min</span>
          </p>
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t border-[color:var(--st-line-10)] pt-6">
            {ctx.hasSocialProof ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[color:var(--st-ink-50)]">Reviews</dt>
                <dd className="mt-1 pp-heading text-3xl font-bold tabular-nums text-[color:var(--st-ink)]">
                  <span ref={reviewsStat.ref}>{reviewsStat.value}</span>
                </dd>
              </div>
            ) : null}
            {ctx.services.length >= 3 ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[color:var(--st-ink-50)]">Treatments</dt>
                <dd className="mt-1 pp-heading text-3xl font-bold tabular-nums text-[color:var(--st-ink)]">
                  <span ref={servicesStat.ref}>{servicesStat.value}</span>
                </dd>
              </div>
            ) : null}
            {ctx.hasSocialProof ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[color:var(--st-ink-50)]">Average rating</dt>
                <dd className="mt-1 pp-heading text-3xl font-bold tabular-nums text-[color:var(--st-ink)]">{ctx.statsRating}★</dd>
              </div>
            ) : null}
          </dl>
          <Link
            to={`/${ctx.shopSlug}/book?serviceId=${encodeURIComponent(featured.id)}`}
            className="mt-8 inline-flex min-h-12 items-center justify-center gap-1.5 rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] transition hover:brightness-110"
          >
            Book this <span aria-hidden>→</span>
          </Link>
        </div>
      </div>
    </section>
  );
}
