import type { SiteRenderContext } from "~/components/site/sectionContext";

export function HowSection({
  ctx,
  stepsStyle,
  glow,
}: {
  ctx: SiteRenderContext;
  stepsStyle: "grid" | "row";
  glow: boolean;
}) {
  return (
    <section className="relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 py-16 md:px-6 md:py-24">
      {glow && (
        <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-[color:var(--st-accent-10)] blur-3xl" aria-hidden />
      )}
      <div className="relative mx-auto max-w-7xl">
        <h2 className="text-center pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">How it works</h2>
        <p className="mx-auto mt-3 max-w-md text-center text-[color:var(--st-ink-55)]">{ctx.archetype.howSub}</p>
        {stepsStyle === "row" ? (
          <ol className="mx-auto mt-12 flex w-full max-w-2xl flex-col gap-8">
            {ctx.steps.map((step) => (
              <li key={step.n} className="flex gap-5 text-left">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[color:var(--st-accent-15)] pp-heading text-lg font-bold text-[color:var(--st-accent-text)] ring-1 ring-[color:var(--st-accent-25)]">
                  {step.n}
                </span>
                <div>
                  <h3 className="text-xl font-semibold text-[color:var(--st-ink)] pp-heading">{step.t}</h3>
                  <p className="mt-2 text-sm text-[color:var(--st-ink-60)]">{step.d}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {ctx.steps.map((step) => (
              <div key={step.n} className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[var(--st-r-lg)] bg-[color:var(--st-accent-15)] text-[color:var(--st-accent-text)] ring-1 ring-[color:var(--st-accent-25)]">
                  <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor">{step.icon}</svg>
                </div>
                <p className="mt-4 text-sm font-bold text-[color:var(--st-accent-text)]">Step {step.n}</p>
                <h3 className="mt-2 text-xl font-semibold text-[color:var(--st-ink)] pp-heading">{step.t}</h3>
                <p className="mt-2 text-sm text-[color:var(--st-ink-60)]">{step.d}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
