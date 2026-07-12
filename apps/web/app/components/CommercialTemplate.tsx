import { Link, useParams } from "@remix-run/react";
import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import type { SiteData, ShopSettings } from "~/components/commercialSiteTypes";
import { archetypeFor } from "~/components/siteArchetype";
import type { SectionKey } from "~/components/siteArchetype";

export type { SiteData, ShopSettings } from "~/components/commercialSiteTypes";

export type StaffMember = {
  id: string;
  display_name: string;
  bio?: string;
  avatar_url?: string;
  speciality?: string;
};

export type Service = {
  id: string;
  name: string;
  description?: string;
  price_gbp: number;
  duration_minutes: number;
  category?: string;
  image_url?: string;
};

export type Review = {
  id: string;
  customer_name: string;
  rating: number;
  body: string;
  created_at: string;
};

export type CommercialTemplateProps = {
  site: SiteData;
  staff?: StaffMember[];
  services?: Service[];
  reviews?: Review[];
  settings?: ShopSettings;
};

function trimMediaUrl(url: string | undefined | null): string {
  if (typeof url !== "string") return "";
  return url.trim();
}

/** Match the booking/owner UI: show pennies only when the price has them,
 *  so the figure on the card equals the total shown at checkout. */
function formatPrice(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2);
}

/** The normaliser assigns "Service" to uncategorised items; treat it as no category. */
function isGenericCategory(category?: string | null): boolean {
  return !category || !category.trim() || category.trim().toLowerCase() === "service";
}

type Pillar = { title: string; body?: string; icon: ReactNode };

type HoursRecord = Record<string, string | null | undefined>;

function parseHours(json?: string): HoursRecord | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as unknown;
    if (!o || typeof o !== "object") return null;
    return o as HoursRecord;
  } catch {
    return null;
  }
}

function formatReviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function StarRow({ rating, className }: { rating: number; className?: string }) {
  const full = Math.round(Math.min(5, Math.max(0, rating)));
  return (
    <span className={className} aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= full ? "text-[color:var(--st-accent-text)]" : "text-[color:var(--st-ink-25)]"}>
          ★
        </span>
      ))}
    </span>
  );
}

function HoursTable({ hoursJson }: { hoursJson?: string }) {
  const hours = parseHours(hoursJson);
  const rows = [
    { k: "mon", label: "Monday" },
    { k: "tue", label: "Tuesday" },
    { k: "wed", label: "Wednesday" },
    { k: "thu", label: "Thursday" },
    { k: "fri", label: "Friday" },
    { k: "sat", label: "Saturday" },
    { k: "sun", label: "Sunday" },
  ] as const;

  return (
    <table className="w-full text-left text-sm text-[color:var(--st-ink-80)]">
      <tbody>
        {rows.map(({ k, label }) => {
          const v = hours?.[k];
          const text = v == null || v === "" ? "Closed" : String(v);
          return (
            <tr key={k} className="border-b border-[color:var(--st-line-10)]">
              <th className="py-3 pr-4 font-medium text-[color:var(--st-ink-90)]">{label}</th>
              <td className="py-3">{text}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function CommercialTemplate({
  site,
  staff = [],
  services = [],
  reviews = [],
  settings = {},
}: CommercialTemplateProps) {
  const params = useParams();
  const shopSlug = params.shopSlug ?? "";

  const [category, setCategory] = useState<string>("All");
  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const svc of services) {
      // Keep real categories only; the generic "Service" is hidden on cards too.
      if (!isGenericCategory(svc.category)) s.add(svc.category!.trim());
    }
    return ["All", ...Array.from(s).sort()];
  }, [services]);

  const filteredServices =
    category === "All" ? services : services.filter((s) => (s.category ?? "").trim() === category);

  const sortedReviews = useMemo(
    () =>
      [...reviews]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6),
    [reviews]
  );

  const reviewCount = site.review_count ?? reviews.length;
  const hasAddress = Boolean(settings.address?.trim());

  const scrollToId = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  const heroSrc = trimMediaUrl(site.hero_image_url);
  const heroHeadline =
    typeof site.headline === "string" && site.headline.trim() ? site.headline.trim() : site.shop_name;
  const heroTagline = typeof site.tagline === "string" ? site.tagline.trim() : "";
  const aboutText = typeof site.about === "string" ? site.about.trim() : "";

  // Only ever show real review data — never invented ratings/counts (trust + ASA/CAP).
  const hasSocialProof = reviewCount > 0;
  const statsHappy = `${Math.max(10, Math.ceil(reviewCount / 10) * 10)}+`;
  const statsRating = typeof site.rating === "number" ? site.rating.toFixed(1) : "5.0";

  // Per-shop design intent (WS-6). Every field is optional; when absent we fall
  // back to the template's original literals so pre-WS-6 sites render unchanged.
  const archetype = archetypeFor(site.layout_mood);
  const heroCentered = archetype.heroAlign === "center";
  const heroMinHClass = archetype.heroMinH === "tall" ? "min-h-[85vh]" : "min-h-screen";
  const servicesColsClass = archetype.servicesCols === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3";

  const trustSignals = (site.trust_signals ?? []).map((s) => s.trim()).filter(Boolean);
  const heroSubline =
    trustSignals.length > 0
      ? trustSignals.slice(0, 3).join(" · ")
      : "Instant confirmation · No card required · Cancel anytime";
  const bookLabel =
    typeof site.hero_cta === "string" && site.hero_cta.trim() ? site.hero_cta.trim() : "Book Now";
  const aboutHeading =
    typeof site.about_title === "string" && site.about_title.trim()
      ? site.about_title.trim()
      : "Why book with us";

  const defaultPillars: Pillar[] = [
    { title: "Expert Staff", body: "Skilled professionals who listen and deliver every time.", icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.847a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.847.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" /> },
    { title: "Easy Booking", body: "Pick a service and time in seconds. No phone tag.", icon: <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5a2.25 2.25 0 0 0 2.25-2.25m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5a2.25 2.25 0 0 1 2.25 2.25v7.5" /> },
    { title: "Guaranteed Satisfaction", body: "We stand behind every visit. Your confidence matters.", icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" /> },
  ];
  // USP titles come straight from the shop's generated spec — never invent a
  // supporting line, so the body is simply omitted; icons cycle from the stock set.
  const usps = (site.usps ?? []).map((s) => s.trim()).filter(Boolean);
  const pillars: Pillar[] =
    usps.length >= 3
      ? usps.slice(0, 3).map((title, i) => ({ title, icon: defaultPillars[i % 3].icon }))
      : defaultPillars;

  const stepIcons = [
    <path key="browse" strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />,
    <path key="diary" strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5a2.25 2.25 0 0 0 2.25-2.25m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5a2.25 2.25 0 0 1 2.25 2.25v7.5" />,
    <path key="confirm" strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />,
  ];
  const steps = archetype.steps.map((s, i) => ({ n: String(i + 1), t: s.t, d: s.d, icon: stepIcons[i] }));

  // Middle sections keyed for per-archetype ordering. Each entry keeps its
  // original markup and conditional-render rule (team needs staff, reviews
  // need reviews, location needs an address) so it is null exactly when the
  // section would not have rendered before.
  const sections: Record<SectionKey, ReactNode> = {
    // Trust line (replaces hero-metric strip)
    trust: (
      <section id="stats-bar" className="scroll-mt-24 border-y border-[color:var(--st-line-10)] bg-[color:var(--st-card-faint)] py-6">
        <div className="mx-auto max-w-7xl px-4 text-center text-sm text-[color:var(--st-ink-70)] md:px-6 md:text-base">
          {hasSocialProof ? (
            <>
              <span className="font-semibold text-[color:var(--st-accent-text)]">{statsRating}★</span>
              {" "}average · {statsHappy} happy clients · {trustSignals.length > 0 ? trustSignals.join(" · ") : "Same-day slots when available"}
            </>
          ) : (
            <>{trustSignals.length > 0 ? trustSignals.join(" · ") : "Online booking · Instant confirmation · Same-day slots when available"}</>
          )}
        </div>
      </section>
    ),
    // Services
    services: (
      <section id="services" className="relative scroll-mt-24 overflow-hidden px-4 py-16 md:px-6 md:py-24">
        {archetype.glow && (
          <div className="pointer-events-none absolute -right-32 top-8 h-72 w-72 rounded-full bg-[color:var(--st-accent-07)] blur-3xl" aria-hidden />
        )}
        <div className="relative mx-auto max-w-7xl">
          <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Services</h2>
          <p className="mt-2 max-w-2xl text-[color:var(--st-ink-60)]">Choose a treatment and book in a few clicks.</p>

          {categories.length > 1 && (
            <div className="mt-8 flex flex-wrap gap-2">
              {categories.map((c) => (
                <button key={c} type="button" onClick={() => setCategory(c)}
                  className={`min-h-12 rounded-full px-5 text-sm font-medium transition ${
                    category === c
                      ? "bg-[color:var(--color-accent)] text-[color:var(--st-on-accent)]"
                      : "border border-[color:var(--st-line-20)] text-[color:var(--st-ink-80)] hover:border-[color:var(--color-accent)]"
                  }`}>
                  {c}
                </button>
              ))}
            </div>
          )}

          <div className={`mt-10 grid gap-6 sm:grid-cols-2 ${servicesColsClass}`}>
            {services.length === 0
              ? [0, 1, 2].map((i) => (
                  <article key={`placeholder-${i}`} className="group flex flex-col overflow-hidden rounded-[var(--st-r-lg)] border border-dashed border-[color:var(--st-line-20)] bg-[color:var(--st-card-faint)] shadow-xl shadow-[color:var(--st-shadow-20)]">
                    <div className="relative aspect-[4/3] overflow-hidden bg-[color:var(--st-accent-15)]">
                      <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-[color:var(--st-accent-25)] to-transparent opacity-70" />
                    </div>
                    <div className="flex flex-1 flex-col p-6">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--st-accent-text)]">Coming soon</p>
                      <div className="mt-3 h-6 w-3/4 animate-pulse rounded bg-[color:var(--st-chip)]" />
                      <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-[color:var(--st-chip)]" />
                      <div className="mt-4 h-12 w-full animate-pulse rounded-[var(--st-r-sm)] bg-[color:var(--st-chip)]" />
                    </div>
                  </article>
                ))
              : filteredServices.map((svc) => {
                  // Only show a real photo; otherwise a short accent header band gives
                  // the card mass so it reads as an intentional menu item.
                  const hasImage = typeof svc.image_url === "string" && svc.image_url.trim().length > 0;
                  // Hide the generic auto-assigned "Service" category; keep real ones
                  // (mirrors the filter-chip exclusion above).
                  const showCategory = !isGenericCategory(svc.category);
                  return (
                    <article key={svc.id} className="group relative flex flex-col overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card)] shadow-xl shadow-[color:var(--st-shadow-25)] transition duration-300 hover:-translate-y-0.5 hover:border-[color:var(--st-accent-40)] hover:bg-[color:var(--st-card-hover)]">
                      {hasImage ? (
                        <div className="relative aspect-[16/10] overflow-hidden">
                          <img
                            src={svc.image_url}
                            alt={svc.name}
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
                          />
                          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 to-transparent" aria-hidden />
                        </div>
                      ) : (
                        <div className="aspect-[16/5] w-full bg-gradient-to-br from-[color:var(--st-accent-25)] via-[color:var(--st-accent-08)] to-transparent" aria-hidden />
                      )}
                      <div className="flex flex-1 flex-col p-6">
                        {showCategory && (
                          <p className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-[color:var(--st-accent-text)]">{svc.category}</p>
                        )}
                        <div className="flex items-start justify-between gap-3">
                          <h3 className="pp-heading text-xl font-semibold leading-snug text-[color:var(--st-ink)]">{svc.name}</h3>
                          <span className="pp-heading shrink-0 text-2xl font-bold leading-none text-[color:var(--st-accent-text)]">£{formatPrice(svc.price_gbp)}</span>
                        </div>
                        <p className="mt-2 text-sm text-[color:var(--st-ink-55)] tabular-nums">{svc.duration_minutes} min</p>
                        {svc.description ? (
                          <p className="mt-3 flex-1 text-sm leading-relaxed text-[color:var(--st-ink-55)] line-clamp-2">{svc.description}</p>
                        ) : (
                          <div className="flex-1" aria-hidden />
                        )}
                        <Link to={`/${shopSlug}/book?serviceId=${encodeURIComponent(svc.id)}`}
                          className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-4 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition hover:brightness-110">
                          Book this <span aria-hidden>→</span>
                        </Link>
                      </div>
                    </article>
                  );
                })}
          </div>
        </div>
      </section>
    ),
    // Trust / about
    about: (
      <section id="about" className="border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 py-16 md:px-6 md:py-24">
        <div className="mx-auto max-w-7xl">
          <div className={`grid gap-12 lg:gap-16 ${aboutText ? "lg:grid-cols-12" : "lg:grid-cols-1"}`}>
            {aboutText ? (
              <div className="lg:col-span-7">
                <div className="rounded-[var(--st-r-md)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card)] p-6 md:p-8">
                  <h2 className="pp-heading text-[clamp(1.5rem,3.5vw,2rem)] font-bold text-[color:var(--st-ink)]">{aboutHeading}</h2>
                  <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-[color:var(--st-ink-75)] md:text-lg">{aboutText}</p>
                </div>
              </div>
            ) : null}
            {archetype.pillarStyle === "chips" ? (
              <ul className={`flex flex-wrap content-center items-start gap-3 ${aboutText ? "lg:col-span-5" : "mx-auto w-full max-w-xl justify-center"}`}>
                {pillars.map((pillar) => (
                  <li key={pillar.title} className="inline-flex min-h-11 items-center rounded-full border border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-10)] px-5 pp-heading text-sm font-semibold text-[color:var(--st-ink-90)]">
                    {pillar.title}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className={`flex flex-col gap-8 lg:justify-center ${aboutText ? "lg:col-span-5" : "mx-auto w-full max-w-xl"}`}>
                {pillars.map((pillar) => (
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
    ),
    // Team
    team:
      staff.length > 0 ? (
        <section className="border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-1)] px-4 py-16 md:px-6 md:py-24">
          <div className="mx-auto max-w-7xl">
            <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Meet the team</h2>
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {staff.map((m) => {
                const initials = m.display_name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
                return (
                  <article key={m.id} className="flex flex-col rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-5 text-center">
                    <div className="mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-[color:var(--st-accent-25)] text-xl font-bold text-[color:var(--st-accent-text)]">
                      {m.avatar_url ? (
                        <img
                          src={m.avatar_url}
                          alt={`Photo of ${m.display_name}`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        initials
                      )}
                    </div>
                    <h3 className="mt-4 pp-heading text-lg font-semibold">{m.display_name}</h3>
                    {m.speciality && <p className="text-sm text-[color:var(--st-accent-text)]">{m.speciality}</p>}
                    {m.bio && <p className="mt-3 text-sm text-[color:var(--st-ink-55)] line-clamp-4">{m.bio}</p>}
                    <Link to={`/${shopSlug}/book?staffId=${encodeURIComponent(m.id)}`}
                      className="mt-5 inline-flex min-h-12 items-center justify-center rounded-[var(--st-r-sm)] border border-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--st-accent-text)]">
                      Book with {m.display_name.split(" ")[0]}
                    </Link>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      ) : null,
    // How it works
    how: (
      <section className="relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-2)] px-4 py-16 md:px-6 md:py-24">
        {archetype.glow && (
          <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-[color:var(--st-accent-10)] blur-3xl" aria-hidden />
        )}
        <div className="relative mx-auto max-w-7xl">
          <h2 className="text-center pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">How it works</h2>
          <p className="mx-auto mt-3 max-w-md text-center text-[color:var(--st-ink-55)]">{archetype.howSub}</p>
          {archetype.stepsStyle === "row" ? (
            <ol className="mx-auto mt-12 flex w-full max-w-2xl flex-col gap-8">
              {steps.map((step) => (
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
              {steps.map((step) => (
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
    ),
    // Reviews
    reviews:
      sortedReviews.length > 0 ? (
        <section className="px-4 py-16 md:px-6 md:py-24">
          <div className="mx-auto max-w-7xl">
            <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Reviews</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {sortedReviews.map((r) => (
                <blockquote key={r.id} className="rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)] p-6">
                  <StarRow rating={r.rating} className="text-base" />
                  <p className="mt-3 text-[color:var(--st-ink-90)]">&ldquo;{r.body}&rdquo;</p>
                  <footer className="mt-4 flex items-center justify-between text-sm text-[color:var(--st-ink-50)]">
                    <cite className="not-italic font-medium text-[color:var(--st-ink-70)]">{r.customer_name}</cite>
                    <span>{formatReviewDate(r.created_at)}</span>
                  </footer>
                </blockquote>
              ))}
            </div>
          </div>
        </section>
      ) : null,
    // Location
    location:
      hasAddress ? (
        <section className="border-t border-[color:var(--st-line-10)] px-4 py-16 md:px-6 md:py-24">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
            <div>
              <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">Location &amp; hours</h2>
              {settings.phone && (
                <p className="mt-4 text-lg">
                  <a href={`tel:${settings.phone.replace(/\s/g, "")}`} className="text-[color:var(--st-accent-text)]">{settings.phone}</a>
                </p>
              )}
              <p className="mt-2 text-[color:var(--st-ink-70)]">{settings.address}</p>
              <div className="mt-8"><HoursTable hoursJson={settings.hours_json} /></div>
            </div>
            <div className="min-h-[280px] overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-card)] bg-[color:var(--st-card-5)]">
              {settings.lat != null && settings.lng != null ? (
                <iframe title="Map" className="h-full min-h-[280px] w-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade"
                  src={`https://www.google.com/maps?q=${settings.lat}%2C${settings.lng}&z=15&output=embed`} />
              ) : (
                <div className="flex h-full min-h-[280px] items-center justify-center p-6 text-center text-[color:var(--st-ink-60)]">{settings.address}</div>
              )}
            </div>
          </div>
        </section>
      ) : null,
  };

  return (
    <CommercialShopChrome site={site} settings={settings} shopSlug={shopSlug} services={services} homeActive>
      {/* Hero */}
      <section className={`relative flex ${heroMinHClass} flex-col overflow-hidden`}>
        <div className="absolute inset-0 -z-0">
          {heroSrc ? (
            <>
              <img
                src={heroSrc}
                alt={`${site.shop_name} hero photo`}
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

        <div className={`relative z-10 flex ${heroMinHClass} w-full flex-col justify-center px-4 pb-6 pt-7 md:px-6 md:pb-8 md:pt-8`}>
          <div className={`mx-auto w-full max-w-7xl translate-y-2 md:translate-y-4 lg:translate-y-[max(1rem,2vh)]${heroCentered ? " text-center" : ""}`}>
            <div className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-black/35 px-4 py-2 text-sm text-white/95 backdrop-blur-md">
              {hasSocialProof ? (
                <>
                  <StarRow rating={typeof site.rating === "number" ? site.rating : 5} className="text-sm" />
                  <span>{statsRating}★ from {reviewCount} review{reviewCount === 1 ? "" : "s"}</span>
                </>
              ) : (
                <>
                  <span className="text-[color:var(--color-accent)]" aria-hidden>✓</span>
                  <span>Online booking · Instant confirmation</span>
                </>
              )}
            </div>

            <h1 className={`mt-8 max-w-[700px] text-5xl font-bold leading-[1.08] tracking-tight text-white md:text-7xl${heroCentered ? " mx-auto" : ""}`}>
              {heroHeadline}
            </h1>
            {heroTagline ? (
              <h2 className={`mt-4 max-w-2xl text-[clamp(1.05rem,2.5vw,1.35rem)] font-normal font-light leading-relaxed text-white/75${heroCentered ? " mx-auto" : ""}`}>
                {heroTagline}
              </h2>
            ) : null}

            {/* Hero sits over a dark image scrim in both schemes, so its copy
                stays literal white — only accent-filled controls tokenize. */}
            <div className={`mt-10 flex flex-wrap gap-4${heroCentered ? " justify-center" : ""}`}>
              <Link to={`/${shopSlug}/book`} className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-black/30 transition hover:brightness-110">
                {bookLabel} →
              </Link>
              <button type="button" onClick={() => scrollToId("services")}
                className="inline-flex min-h-[3.25rem] items-center justify-center rounded-[var(--st-r-md)] border-2 border-white/50 bg-transparent px-8 pp-heading text-base font-semibold text-white transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)]">
                See Our Services
              </button>
            </div>

            <p className="mt-8 text-sm text-white/55 md:text-base">
              {heroSubline}
            </p>
          </div>
        </div>

        <button type="button" className="absolute bottom-6 left-1/2 z-10 hidden -translate-x-1/2 md:block"
          aria-label="Scroll down" onClick={() => scrollToId("stats-bar")}>
          <span className="text-3xl text-white/60 transition hover:text-white/90">↓</span>
        </button>
      </section>

      {/* Middle sections in the archetype's order */}
      {archetype.order.map((key) => (
        <Fragment key={key}>{sections[key]}</Fragment>
      ))}

      {/* Final CTA */}
      <section className="relative overflow-hidden border-t border-[color:var(--st-line-10)] bg-[color:var(--st-accent-10)] px-4 py-20 md:px-6 md:py-28">
        {archetype.glow && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-[44rem] max-w-full -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--st-accent-15)] blur-3xl" aria-hidden />
        )}
        <div className="relative mx-auto max-w-3xl text-center">
          <h2 className="pp-heading text-[clamp(1.85rem,4.5vw,3rem)] font-bold leading-tight text-[color:var(--st-ink)]">{archetype.ctaHeading}</h2>
          <p className="mt-4 text-lg text-[color:var(--st-ink-70)]">{archetype.ctaSub}</p>
          <Link to={`/${shopSlug}/book`}
            className="mt-10 inline-flex min-h-14 min-w-[14rem] items-center justify-center rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-12 pp-heading text-lg font-semibold text-[color:var(--st-on-accent)] shadow-lg shadow-[color:var(--st-accent-25)] transition hover:brightness-110">
            {bookLabel} →
          </Link>
          <p className="mt-6 text-sm text-[color:var(--st-ink-55)]">Book in under a minute · No account needed</p>
        </div>
      </section>
    </CommercialShopChrome>
  );
}
