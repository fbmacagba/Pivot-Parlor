import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { sectionPadY } from "~/components/site/sections/bits";

/** About "split-image": the story beside a tall photo pulled from the shop's
 *  own imagery; pillars compress into a chip row under the text. */
export function AboutSplitImageSection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  const img =
    ctx.services.find((s) => typeof s.image_url === "string" && s.image_url.trim())?.image_url ?? ctx.heroSrc;
  return (
    <section id="about" className={`border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 md:px-6 ${sectionPadY(density)}`}>
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 className="pp-heading text-[clamp(1.5rem,3.5vw,2rem)] font-bold text-[color:var(--st-ink)]">{ctx.aboutHeading}</h2>
          {ctx.aboutText ? (
            <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-[color:var(--st-ink-75)] md:text-lg">{ctx.aboutText}</p>
          ) : null}
          <ul className="mt-8 flex flex-wrap gap-3">
            {ctx.pillars.map((pillar) => (
              <li key={pillar.title} className="inline-flex min-h-11 items-center rounded-full border border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-10)] px-5 pp-heading text-sm font-semibold text-[color:var(--st-ink-90)]">
                {pillar.title}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative aspect-[4/5] max-h-[560px] w-full overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)]">
          {img ? (
            <img src={img} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
          )}
        </div>
      </div>
    </section>
  );
}
