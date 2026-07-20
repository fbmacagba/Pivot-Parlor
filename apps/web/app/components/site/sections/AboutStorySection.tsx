import type { Density } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { sectionPadY } from "~/components/site/sections/bits";

/** About "story": a single centred narrative column under an oversized
 *  quotation glyph — the owner's voice, given the floor. */
export function AboutStorySection({ ctx, density }: { ctx: SiteRenderContext; density: Density }) {
  return (
    <section id="about" className={`relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 md:px-6 ${sectionPadY(density)}`}>
      <span className="pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 pp-heading text-[10rem] leading-none text-[color:var(--st-accent-10)]" aria-hidden>
        &ldquo;
      </span>
      <div className="relative mx-auto max-w-3xl pt-16 text-center">
        <h2 className="pp-heading text-[clamp(1.5rem,3.5vw,2rem)] font-bold text-[color:var(--st-ink)]">{ctx.aboutHeading}</h2>
        {ctx.aboutText ? (
          <p className="mx-auto mt-6 max-w-2xl whitespace-pre-line text-left text-lg leading-loose text-[color:var(--st-ink-75)] md:text-xl">{ctx.aboutText}</p>
        ) : null}
        <ul className="mt-10 flex flex-wrap items-start justify-center gap-x-10 gap-y-6">
          {ctx.pillars.map((pillar) => (
            <li key={pillar.title} className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--st-accent-20)] text-[color:var(--st-accent-text)]">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">{pillar.icon}</svg>
              </span>
              <span className="pp-heading text-base font-semibold text-[color:var(--st-ink)]">{pillar.title}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
