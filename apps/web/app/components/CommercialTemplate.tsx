import { Link, useParams } from "@remix-run/react";
import { useMemo, useState } from "react";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import type { SiteData, ShopSettings } from "~/components/commercialSiteTypes";

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
        <span key={i} className={i <= full ? "text-[color:var(--color-accent)]" : "text-white/25"}>
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
    <table className="w-full text-left text-sm text-white/80">
      <tbody>
        {rows.map(({ k, label }) => {
          const v = hours?.[k];
          const text =
            v == null || v === "" ? "Closed" : String(v);
          return (
            <tr key={k} className="border-b border-white/10">
              <th className="py-3 pr-4 font-medium text-white/90">{label}</th>
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
      if (svc.category?.trim()) s.add(svc.category.trim());
    }
    return ["All", ...Array.from(s).sort()];
  }, [services]);

  const filteredServices =
    category === "All" ? services : services.filter((s) => (s.category ?? "").trim() === category);

  const sortedReviews = useMemo(
    () =>
      [...reviews].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 6),
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

  const statsHappy =
    reviewCount > 0
      ? `${Math.max(10, Math.ceil(reviewCount / 10) * 10)}+`
      : "500+";
  const statsRating = typeof site.rating === "number" ? site.rating.toFixed(1) : "4.9";

  return (
    <CommercialShopChrome site={site} settings={settings} shopSlug={shopSlug} homeActive>
      {/* Hero — full viewport, full-bleed image + dark gradient */}
      <section className="relative flex min-h-screen flex-col overflow-hidden">
        <div className="absolute inset-0 -z-0">
          {heroSrc ? (
            <>
              <img
                src={heroSrc}
                alt=""
                className="absolute inset-0 h-full w-full scale-105 object-cover"
                loading="eager"
                decoding="async"
              />
              <div
                className="absolute inset-0 bg-gradient-to-b from-black/85 via-black/65 to-black/90"
                aria-hidden
              />
              <div
                className="absolute inset-0 bg-gradient-to-r from-black/50 via-transparent to-black/40"
                aria-hidden
              />
            </>
          ) : (
            <>
              <div
                className="h-full w-full"
                style={{
                  background:
                    "linear-gradient(145deg, var(--color-brand) 0%, #000 45%, var(--color-accent) 160%)",
                }}
                aria-hidden
              />
              <div
                className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/55 to-black/90"
                aria-hidden
              />
            </>
          )}
        </div>

        <div className="relative z-10 flex min-h-screen w-full flex-col justify-center px-4 pb-6 pt-7 md:px-6 md:pb-8 md:pt-8">
          <div className="mx-auto w-full max-w-7xl translate-y-2 md:translate-y-4 lg:translate-y-[max(1rem,2vh)]">
            <div className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-black/35 px-4 py-2 text-sm text-white/95 backdrop-blur-md">
              <span className="tracking-tight text-[color:var(--color-accent)]" aria-hidden>
                ⭐⭐⭐⭐⭐
              </span>
              <span>
                Rated 5 stars by our clients
                {reviewCount > 0 ? ` · ${reviewCount} reviews` : ""}
              </span>
            </div>

            <h1 className="mt-8 max-w-[700px] text-5xl font-bold leading-[1.08] tracking-tight text-white md:text-7xl">
              {heroHeadline}
            </h1>
            {heroTagline ? (
              <h2 className="mt-4 max-w-2xl text-[clamp(1.05rem,2.5vw,1.35rem)] font-normal font-light leading-relaxed text-white/75">
                {heroTagline}
              </h2>
            ) : null}

            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                to={`/${shopSlug}/book`}
                className="inline-flex min-h-[3.25rem] items-center justify-center rounded-xl bg-[color:var(--color-accent)] px-8 pp-heading text-base font-semibold text-black shadow-lg shadow-black/30 transition hover:brightness-110"
              >
                Book Now →
              </Link>
              <button
                type="button"
                onClick={() => scrollToId("services")}
                className="inline-flex min-h-[3.25rem] items-center justify-center rounded-xl border-2 border-white/50 bg-transparent px-8 pp-heading text-base font-semibold text-white transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)]"
              >
                See Our Services
              </button>
            </div>

            <p className="mt-8 text-sm text-white/55 md:text-base">
              Instant confirmation · No card required · Cancel anytime
            </p>
          </div>
        </div>

        <button
          type="button"
          className="absolute bottom-6 left-1/2 z-10 hidden -translate-x-1/2 animate-bounce md:block"
          aria-label="Scroll down"
          onClick={() => scrollToId("stats-bar")}
        >
          <span className="text-3xl text-white/70">↓</span>
        </button>
      </section>

      {/* Stats bar */}
      <section
        id="stats-bar"
        className="scroll-mt-24 border-y border-white/10 bg-black/55 py-10 backdrop-blur-sm"
      >
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:grid-cols-3 md:px-6">
          <div className="text-center sm:text-left">
            <p className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold tabular-nums text-[color:var(--color-accent)]">
              {statsHappy}
            </p>
            <p className="mt-1 text-sm font-medium text-white/65">Happy Clients</p>
          </div>
          <div className="text-center">
            <p className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold tabular-nums text-[color:var(--color-accent)]">
              {statsRating}★
            </p>
            <p className="mt-1 text-sm font-medium text-white/65">Average Rating</p>
          </div>
          <div className="text-center sm:text-right">
            <p className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--color-accent)]">
              Same-Day
            </p>
            <p className="mt-1 text-sm font-medium text-white/65">Slots Available</p>
          </div>
        </div>
      </section>

      {/* Services */}
      <section id="services" className="scroll-mt-24 px-4 py-16 md:px-6 md:py-24">
        <div className="mx-auto max-w-7xl">
          <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-white">
            Services
          </h2>
          <p className="mt-2 max-w-2xl text-white/60">Choose a treatment and book in a few clicks.</p>

          {categories.length > 1 && (
            <div className="mt-8 flex flex-wrap gap-2">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`min-h-12 rounded-full px-5 text-sm font-medium transition ${
                    category === c
                      ? "bg-[color:var(--color-accent)] text-black"
                      : "border border-white/20 text-white/80 hover:border-[color:var(--color-accent)]"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {services.length === 0
              ? [0, 1, 2].map((i) => (
                  <article
                    key={`placeholder-${i}`}
                    className="group flex flex-col overflow-hidden rounded-2xl border border-dashed border-white/20 bg-white/[0.03] shadow-xl shadow-black/20"
                  >
                    <div className="relative aspect-[4/3] overflow-hidden bg-[color:var(--color-accent)]/15">
                      <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-[color:var(--color-accent)]/25 to-transparent opacity-70" />
                    </div>
                    <div className="flex flex-1 flex-col p-6">
                      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-accent)]/90">
                        Coming soon
                      </p>
                      <div className="mt-3 h-6 w-3/4 animate-pulse rounded bg-white/10" />
                      <div className="mt-3 h-4 w-1/2 animate-pulse rounded bg-white/10" />
                      <div className="mt-4 h-12 w-full animate-pulse rounded-lg bg-white/10" />
                    </div>
                  </article>
                ))
              : filteredServices.map((svc) => (
                  <article
                    key={svc.id}
                    className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] shadow-xl shadow-black/25 transition hover:border-[color:var(--color-accent)]/35"
                  >
                    <div className="relative aspect-[4/3] overflow-hidden bg-[color:var(--color-accent)]/15">
                      {svc.image_url ? (
                        <img src={svc.image_url} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                      ) : (
                        <div
                          className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center"
                          aria-hidden
                        >
                          <span className="text-4xl text-[color:var(--color-accent)] drop-shadow-[0_0_18px_rgba(255,255,255,0.12)]">
                            ✦
                          </span>
                          <span className="text-xs font-medium uppercase tracking-wider text-[color:var(--color-accent)]/80">
                            Service
                          </span>
                        </div>
                      )}
                      <div
                        className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 transition group-hover:opacity-100"
                        aria-hidden
                      />
                    </div>
                    <div className="flex flex-1 flex-col p-6">
                      {svc.category && (
                        <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-accent)]">
                          {svc.category}
                        </p>
                      )}
                      <h3 className="mt-1 text-xl font-semibold text-white pp-heading">{svc.name}</h3>
                      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-white/70">
                        <span className="tabular-nums">{svc.duration_minutes} min</span>
                        <span className="text-white/35" aria-hidden>
                          ·
                        </span>
                        <span className="pp-heading text-lg font-semibold text-[color:var(--color-accent)]">
                          £{svc.price_gbp.toFixed(0)}
                        </span>
                      </div>
                      {svc.description && (
                        <p className="mt-3 flex-1 text-sm text-white/50 line-clamp-2">{svc.description}</p>
                      )}
                      <Link
                        to={`/${shopSlug}/book?serviceId=${encodeURIComponent(svc.id)}`}
                        className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-[color:var(--color-accent)] px-4 pp-heading text-sm font-semibold text-black transition hover:brightness-110"
                      >
                        Book This
                      </Link>
                    </div>
                  </article>
                ))}
          </div>
        </div>
      </section>

      {/* Trust / about */}
      <section
        id="about"
        className="border-t border-white/10 bg-black/20 px-4 py-16 md:px-6 md:py-24"
      >
        <div className="mx-auto max-w-7xl">
          <div
            className={`grid gap-12 lg:gap-16 ${aboutText ? "lg:grid-cols-12" : "lg:grid-cols-1"}`}
          >
            {aboutText ? (
              <div className="lg:col-span-7">
                <div className="border-l-4 border-[color:var(--color-accent)] pl-6 md:pl-8">
                  <h2 className="pp-heading text-[clamp(1.5rem,3.5vw,2rem)] font-bold text-white">
                    Why book with us
                  </h2>
                  <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-white/75 md:text-lg">
                    {aboutText}
                  </p>
                </div>
              </div>
            ) : null}
            <ul
              className={`flex flex-col gap-8 lg:justify-center ${aboutText ? "lg:col-span-5" : "mx-auto w-full max-w-xl"}`}
            >
                {[
                  {
                    title: "Expert Staff",
                    body: "Skilled professionals who listen and deliver every time.",
                    icon: (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.847a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.847.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z"
                      />
                    ),
                  },
                  {
                    title: "Easy Booking",
                    body: "Pick a service and time in seconds—no phone tag.",
                    icon: (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5a2.25 2.25 0 0 0 2.25-2.25m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5a2.25 2.25 0 0 1 2.25 2.25v7.5"
                      />
                    ),
                  },
                  {
                    title: "Guaranteed Satisfaction",
                    body: "We stand behind every visit—your confidence matters.",
                    icon: (
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
                      />
                    ),
                  },
                ].map((pillar) => (
                  <li key={pillar.title} className="flex gap-4">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[color:var(--color-accent)]/20 text-[color:var(--color-accent)]">
                      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        {pillar.icon}
                      </svg>
                    </span>
                    <div>
                      <h3 className="pp-heading text-lg font-semibold text-white">{pillar.title}</h3>
                      <p className="mt-1 text-sm text-white/60">{pillar.body}</p>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Team */}
      {staff.length > 0 && (
        <section className="border-t border-white/10 bg-black/15 px-4 py-16 md:px-6 md:py-24">
          <div className="mx-auto max-w-7xl">
            <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-white">
              Meet the team
            </h2>
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {staff.map((m) => {
                const initials = m.display_name
                  .split(/\s+/)
                  .map((p) => p[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase();
                return (
                  <article
                    key={m.id}
                    className="flex flex-col rounded-2xl border border-white/10 bg-white/5 p-5 text-center"
                  >
                    <div className="mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-[color:var(--color-accent)]/25 text-xl font-bold text-[color:var(--color-accent)]">
                      {m.avatar_url ? (
                        <img src={m.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        initials
                      )}
                    </div>
                    <h3 className="mt-4 pp-heading text-lg font-semibold">{m.display_name}</h3>
                    {m.speciality && <p className="text-sm text-[color:var(--color-accent)]">{m.speciality}</p>}
                    {m.bio && <p className="mt-3 text-sm text-white/55 line-clamp-4">{m.bio}</p>}
                    <Link
                      to={`/${shopSlug}/book?staffId=${encodeURIComponent(m.id)}`}
                      className="mt-5 inline-flex min-h-12 items-center justify-center rounded-lg border border-[color:var(--color-accent)] px-4 font-semibold text-[color:var(--color-accent)]"
                    >
                      Book with {m.display_name.split(" ")[0]}
                    </Link>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* How it works */}
      <section className="border-t border-white/10 bg-black/20 px-4 py-16 md:px-6 md:py-24">
        <div className="mx-auto max-w-7xl">
          <h2 className="text-center pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-white">
            How it works
          </h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {[
              {
                n: "1",
                t: "Choose a service",
                d: "Browse treatments and pick what suits you.",
                icon: "✨",
              },
              {
                n: "2",
                t: "Pick your time",
                d: "Select a staff member and a slot that fits your diary.",
                icon: "📅",
              },
              {
                n: "3",
                t: "Confirm & pay",
                d: "Lock in your booking and arrive relaxed.",
                icon: "✓",
              },
            ].map((step) => (
              <div key={step.n} className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[color:var(--color-accent)]/20 text-3xl">
                  {step.icon}
                </div>
                <p className="mt-4 text-sm font-bold text-[color:var(--color-accent)]">Step {step.n}</p>
                <h3 className="mt-2 text-xl font-semibold text-white pp-heading">{step.t}</h3>
                <p className="mt-2 text-sm text-white/60">{step.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Reviews */}
      {sortedReviews.length > 0 && (
        <section className="px-4 py-16 md:px-6 md:py-24">
          <div className="mx-auto max-w-7xl">
            <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-white">
              Reviews
            </h2>
            <div className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {sortedReviews.map((r) => (
                <blockquote
                  key={r.id}
                  className="rounded-2xl border border-white/10 bg-white/5 p-6"
                >
                  <StarRow rating={r.rating} className="text-base" />
                  <p className="mt-3 text-white/90">&ldquo;{r.body}&rdquo;</p>
                  <footer className="mt-4 flex items-center justify-between text-sm text-white/50">
                    <cite className="not-italic font-medium text-white/70">{r.customer_name}</cite>
                    <span>{formatReviewDate(r.created_at)}</span>
                  </footer>
                </blockquote>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Location */}
      {hasAddress && (
        <section className="border-t border-white/10 px-4 py-16 md:px-6 md:py-24">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
            <div>
              <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-white">
                Location & hours
              </h2>
              {settings.phone && (
                <p className="mt-4 text-lg">
                  <a href={`tel:${settings.phone.replace(/\s/g, "")}`} className="text-[color:var(--color-accent)]">
                    {settings.phone}
                  </a>
                </p>
              )}
              <p className="mt-2 text-white/70">{settings.address}</p>
              <div className="mt-8">
                <HoursTable hoursJson={settings.hours_json} />
              </div>
            </div>
            <div className="min-h-[280px] overflow-hidden rounded-2xl border border-white/10 bg-white/5">
              {settings.lat != null && settings.lng != null ? (
                <iframe
                  title="Map"
                  className="h-full min-h-[280px] w-full border-0"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  src={`https://www.google.com/maps?q=${settings.lat}%2C${settings.lng}&z=15&output=embed`}
                />
              ) : (
                <div className="flex h-full min-h-[280px] items-center justify-center p-6 text-center text-white/60">
                  {settings.address}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Final CTA */}
      <section className="border-t border-white/10 bg-[color:var(--color-accent)]/10 px-4 py-20 md:px-6 md:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="pp-heading text-[clamp(1.85rem,4.5vw,3rem)] font-bold leading-tight text-white">
            Ready for your best look?
          </h2>
          <p className="mt-4 text-lg text-white/70">Book your appointment in 60 seconds.</p>
          <Link
            to={`/${shopSlug}/book`}
            className="mt-10 inline-flex min-h-14 min-w-[14rem] items-center justify-center rounded-xl bg-[color:var(--color-accent)] px-12 pp-heading text-lg font-semibold text-black shadow-lg shadow-black/25 transition hover:brightness-110"
          >
            Book Now →
          </Link>
        </div>
      </section>
    </CommercialShopChrome>
  );
}
