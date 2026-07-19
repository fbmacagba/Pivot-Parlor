import type { SiteRenderContext } from "~/components/site/sectionContext";

export function AboutSection({
  ctx,
  pillarStyle,
}: {
  ctx: SiteRenderContext;
  pillarStyle: "icons" | "chips";
}) {
  return (
    <section id="about" className="border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 py-16 md:px-6 md:py-24">
      <div className="mx-auto max-w-7xl">
        <div className={`grid gap-12 lg:gap-16 ${ctx.aboutText ? "lg:grid-cols-12" : "lg:grid-cols-1"}`}>
          {ctx.aboutText ? (
            <div className="lg:col-span-7">
              <div className="rounded-[var(--st-r-md)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card)] p-6 md:p-8">
                <h2 className="pp-heading text-[clamp(1.5rem,3.5vw,2rem)] font-bold text-[color:var(--st-ink)]">{ctx.aboutHeading}</h2>
                <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-[color:var(--st-ink-75)] md:text-lg">{ctx.aboutText}</p>
              </div>
            </div>
          ) : null}
          {pillarStyle === "chips" ? (
            <ul className={`flex flex-wrap content-center items-start gap-3 ${ctx.aboutText ? "lg:col-span-5" : "mx-auto w-full max-w-xl justify-center"}`}>
              {ctx.pillars.map((pillar) => (
                <li key={pillar.title} className="inline-flex min-h-11 items-center rounded-full border border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-10)] px-5 pp-heading text-sm font-semibold text-[color:var(--st-ink-90)]">
                  {pillar.title}
                </li>
              ))}
            </ul>
          ) : (
            <ul className={`flex flex-col gap-8 lg:justify-center ${ctx.aboutText ? "lg:col-span-5" : "mx-auto w-full max-w-xl"}`}>
              {ctx.pillars.map((pillar) => (
                <li key={pillar.title} className="flex gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--st-accent-20)] text-[color:var(--st-accent-text)]">
                    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">{pillar.icon}</svg>
                  </span>
                  <div>
                    <h3 className="pp-heading text-lg font-semibold text-[color:var(--st-ink)]">{pillar.title}</h3>
                    {pillar.body ? <p className="mt-1 text-sm text-[color:var(--st-ink-60)]">{pillar.body}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
