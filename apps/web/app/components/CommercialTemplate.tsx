import { Link, useParams } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ChatWidget from "~/components/ChatWidget";

export type SiteData = {
  shop_name: string;
  /** Marketing / display title from shop_sites.headline; hero falls back to shop_name if empty */
  headline?: string;
  /** Subhead from shop_sites.tagline */
  tagline: string;
  /** Long-form about copy from shop_sites.about */
  about?: string;
  /** Google Fonts family name for headings (e.g. Playfair Display) */
  font_heading?: string;
  /** Google Fonts family name for body text */
  font_body?: string;
  hero_image_url?: string;
  logo_url?: string;
  color_primary?: string;
  color_accent?: string;
  seo_title?: string;
  description?: string;
  rating?: number;
  review_count?: number;
};

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

export type ShopSettings = {
  phone?: string;
  address?: string;
  lat?: number;
  lng?: number;
  hours_json?: string;
  instagram_url?: string;
  facebook_url?: string;
  tiktok_url?: string;
  twitter_url?: string;
  youtube_url?: string;
  whatsapp_url?: string;
  linkedin_url?: string;
  show_instagram?: boolean;
  show_facebook?: boolean;
  show_tiktok?: boolean;
  show_twitter?: boolean;
  show_youtube?: boolean;
  show_whatsapp?: boolean;
  show_linkedin?: boolean;
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

/** Sanitize font family for Google Fonts URL (alphanumeric, spaces, hyphens). */
function googleFontFamilyToken(name: string): string | null {
  const safe = name.replace(/[^\w\s-]/g, "").replace(/\s+/g, " ").trim();
  return safe.length ? safe : null;
}

function buildGoogleFontsHref(heading?: string, body?: string): string | null {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of [heading, body]) {
    const t = raw ? googleFontFamilyToken(raw) : null;
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      tokens.push(t);
    }
  }
  if (tokens.length === 0) return null;
  const params = tokens.map((t) => `family=${t.replace(/ /g, "+")}:wght@400;500;600;700`);
  return `https://fonts.googleapis.com/css2?${params.join("&")}&display=swap`;
}

const COOKIE_KEY = "pp_cookie_consent";

const DAY_MAP: Record<number, keyof HoursRecord> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

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

function parseRange(s: string): { start: number; end: number } | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  return { start: sh * 60 + sm, end: eh * 60 + em };
}

function isOpenNow(hours: HoursRecord | null, when: Date): boolean | null {
  if (!hours) return null;
  const key = DAY_MAP[when.getDay()];
  const raw = hours[key];
  if (raw == null || raw === "") return false;
  const range = parseRange(String(raw));
  if (!range) return null;
  const mins = when.getHours() * 60 + when.getMinutes();
  return mins >= range.start && mins < range.end;
}

function formatReviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function shopNameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase() || "?";
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

function OpenNowBadge({ hoursJson }: { hoursJson?: string }) {
  const hours = useMemo(() => parseHours(hoursJson), [hoursJson]);
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    const tick = () => {
      const v = isOpenNow(hours, new Date());
      setOpen(v);
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [hours]);

  const label =
    open === null ? "Hours" : open ? "Open Now" : "Closed";

  return (
    <span
      className={`inline-flex min-h-12 items-center rounded-full px-4 text-sm font-semibold ${
        open === true
          ? "bg-emerald-500/90 text-white"
          : open === false
            ? "bg-white/15 text-white/90"
            : "bg-white/10 text-white/80"
      }`}
    >
      {label}
    </span>
  );
}

function CookieConsentPanel({
  forceOpen,
  onClose,
}: {
  forceOpen: boolean;
  onClose: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    if (forceOpen) {
      setVisible(true);
      return;
    }
    try {
      if (!localStorage.getItem(COOKIE_KEY)) setVisible(true);
    } catch {
      setVisible(true);
    }
  }, [forceOpen]);

  const persist = useCallback(
    (prefs: { analytics: boolean; marketing: boolean }) => {
      const payload = {
        essential: true,
        analytics: prefs.analytics,
        marketing: prefs.marketing,
        timestamp: new Date().toISOString(),
      };
      try {
        localStorage.setItem(COOKIE_KEY, JSON.stringify(payload));
      } catch {
        /* ignore */
      }
      setVisible(false);
      onClose();
    },
    [onClose]
  );

  if (!visible) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[60] border-t border-white/10 bg-[#0a0a0a]/95 p-4 shadow-2xl backdrop-blur-md md:p-6"
      role="dialog"
      aria-label="Cookie preferences"
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="pp-heading text-lg text-white">Cookies & privacy</p>
          <p className="mt-1 max-w-xl text-sm text-white/60">
            We use essential cookies to run the site. You can opt in to analytics and marketing below.
          </p>
          <ul className="mt-4 space-y-3 text-sm text-white/80">
            <li className="flex items-center justify-between gap-4">
              <span>Essential</span>
              <input type="checkbox" checked disabled className="h-6 w-6 accent-[color:var(--color-accent)]" />
            </li>
            <li className="flex items-center justify-between gap-4">
              <span>Analytics</span>
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
                className="h-6 w-6 accent-[color:var(--color-accent)]"
              />
            </li>
            <li className="flex items-center justify-between gap-4">
              <span>Marketing</span>
              <input
                type="checkbox"
                checked={marketing}
                onChange={(e) => setMarketing(e.target.checked)}
                className="h-6 w-6 accent-[color:var(--color-accent)]"
              />
            </li>
          </ul>
        </div>
        <div className="flex min-h-12 flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            className="min-h-12 min-w-[10rem] rounded-lg bg-[color:var(--color-accent)] px-4 font-semibold text-black"
            onClick={() => persist({ analytics: true, marketing: true })}
          >
            Accept All
          </button>
          <button
            type="button"
            className="min-h-12 min-w-[10rem] rounded-lg border border-white/20 px-4 font-medium text-white"
            onClick={() => persist({ analytics, marketing })}
          >
            Save Preferences
          </button>
          <button
            type="button"
            className="min-h-12 min-w-[10rem] rounded-lg border border-white/10 px-4 font-medium text-white/80"
            onClick={() => persist({ analytics: false, marketing: false })}
          >
            Reject All
          </button>
        </div>
      </div>
    </div>
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

function SocialIcon({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-[color:var(--color-accent)]/20 hover:text-[color:var(--color-accent)]"
    >
      {children}
    </a>
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
  const [navOpen, setNavOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [cookieForce, setCookieForce] = useState(false);

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
    setNavOpen(false);
  };

  const fontHeadingName = site.font_heading?.trim();
  const fontBodyName = site.font_body?.trim();
  const headingFallback = '"Playfair Display", Georgia, serif';
  const bodyFallback = '"DM Sans", system-ui, sans-serif';
  const fontHeadingStack = fontHeadingName
    ? `"${fontHeadingName.replace(/"/g, "")}", ${headingFallback}`
    : headingFallback;
  const fontBodyStack = fontBodyName
    ? `"${fontBodyName.replace(/"/g, "")}", ${bodyFallback}`
    : bodyFallback;

  useEffect(() => {
    const href = buildGoogleFontsHref(fontHeadingName, fontBodyName);
    if (!href) return;
    const id = "pp-commercial-site-fonts";
    let link = document.getElementById(id) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }, [fontHeadingName, fontBodyName]);

  const rootStyle = {
    "--color-brand": site.color_primary || "#1a1a1a",
    "--color-accent": site.color_accent || "#d4a853",
    "--pp-font-heading": fontHeadingStack,
    "--pp-font-body": fontBodyStack,
  } as React.CSSProperties;

  const logoSrc = trimMediaUrl(site.logo_url);
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
    <div
      className="pp-commercial min-h-screen bg-[color:var(--color-brand)] text-white"
      style={{
        ...rootStyle,
        fontFamily: "var(--pp-font-body)",
      }}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `.pp-commercial h1,.pp-commercial h2,.pp-commercial h3,.pp-commercial .pp-heading{font-family:var(--pp-font-heading);}`,
        }}
      />
      {/* Sticky nav */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[color:var(--color-brand)]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <Link to={`/${shopSlug}`} className="flex min-h-12 items-center gap-3">
            {logoSrc ? (
              <img
                src={logoSrc}
                alt=""
                className="h-10 w-auto max-w-[min(12rem,40vw)] object-contain"
                loading="eager"
                decoding="async"
              />
            ) : (
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--color-accent)]/50 bg-[color:var(--color-accent)]/15 pp-heading text-sm font-bold text-[color:var(--color-accent)]"
                aria-hidden
              >
                {shopNameInitials(site.shop_name)}
              </span>
            )}
            <span className="pp-heading text-[clamp(1rem,2.5vw,1.25rem)] font-semibold text-white">
              {site.shop_name}
            </span>
          </Link>

          <button
            type="button"
            className="flex min-h-12 min-w-12 items-center justify-center rounded-lg border border-white/20 md:hidden"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
          >
            <span className="text-2xl">☰</span>
          </button>

          <nav className="hidden items-center gap-6 md:flex">
            <Link
              to={`/${shopSlug}/book`}
              className="inline-flex min-h-12 items-center justify-center rounded-lg bg-[color:var(--color-accent)] px-6 pp-heading font-semibold text-black"
            >
              Book Now →
            </Link>
          </nav>
        </div>

        {navOpen && (
          <div className="fixed inset-0 z-50 flex flex-col bg-[color:var(--color-brand)] md:hidden">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <span className="pp-heading text-lg">{site.shop_name}</span>
              <button
                type="button"
                className="min-h-12 min-w-12 text-2xl"
                aria-label="Close menu"
                onClick={() => setNavOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-4 p-6">
              <Link
                to={`/${shopSlug}/book`}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-[color:var(--color-accent)] px-6 pp-heading font-semibold text-black"
              >
                Book Now →
              </Link>
              <button
                type="button"
                className="min-h-12 w-full rounded-lg border border-white/20 px-6 font-medium"
                onClick={() => scrollToId("services")}
              >
                See Our Services
              </button>
            </div>
          </div>
        )}
      </header>

      {/* Hero — full viewport, full-bleed image + dark gradient */}
      <section className="relative flex min-h-screen flex-col justify-center overflow-hidden">
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

        <div className="relative z-10 mx-auto w-full max-w-7xl px-4 py-24 md:px-6 md:py-28">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-black/35 px-4 py-2 text-sm text-white/95 backdrop-blur-md">
              <span className="tracking-tight text-[color:var(--color-accent)]" aria-hidden>
                ⭐⭐⭐⭐⭐
              </span>
              <span>
                Rated 5 stars by our clients
                {reviewCount > 0 ? ` · ${reviewCount} reviews` : ""}
              </span>
            </div>
            <OpenNowBadge hoursJson={settings.hours_json} />
          </div>

          <h1 className="mt-8 max-w-[18ch] text-[clamp(2.25rem,6.5vw,4rem)] font-bold leading-[1.08] tracking-tight text-white line-clamp-2 md:max-w-[22ch]">
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

      {/* Footer */}
      <footer className="border-t border-white/10 bg-black/30 px-4 py-12 md:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-10 md:flex-row md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              {logoSrc ? (
                <img
                  src={logoSrc}
                  alt=""
                  className="h-10 w-auto max-w-[min(12rem,40vw)] object-contain"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--color-accent)]/50 bg-[color:var(--color-accent)]/15 pp-heading text-sm font-bold text-[color:var(--color-accent)]"
                  aria-hidden
                >
                  {shopNameInitials(site.shop_name)}
                </span>
              )}
              <span className="pp-heading text-lg font-semibold">{site.shop_name}</span>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {settings.show_instagram && settings.instagram_url && (
                <SocialIcon href={settings.instagram_url} label="Instagram">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7zm5 3.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 0 1 12 7.5zm0 2A2.5 2.5 0 1 0 14.5 12 2.5 2.5 0 0 0 12 9.5zm5.25-3a1.25 1.25 0 1 1-1.25 1.25A1.25 1.25 0 0 1 17.25 6.5z" />
                  </svg>
                </SocialIcon>
              )}
              {settings.show_facebook && settings.facebook_url && (
                <SocialIcon href={settings.facebook_url} label="Facebook">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M13.5 22v-9h3l.5-4h-3.5V7c0-1 .6-1.5 1.8-1.5H17V2h-3c-3.2 0-5 2-5 5v2H7v4h2v9h4.5z" />
                  </svg>
                </SocialIcon>
              )}
              {settings.show_tiktok && settings.tiktok_url && (
                <SocialIcon href={settings.tiktok_url} label="TikTok">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M16.6 5.82s.51.5.81 1.32l.01-.01-1.05-.36c.11 1.08.01 2.12-.01 2.12-.33-.02-2.02-.67-3.4-2.12v8.5A3.5 3.5 0 1 1 9 12.32V9.66a5.5 5.5 0 0 0 1 .06c.55-.02 1.09-.18 1.58-.45v2.13c.65.38 1.35.6 2.08.64 1.02.06 2.02-.28 2.94-.94z" />
                  </svg>
                </SocialIcon>
              )}
              {settings.show_twitter && settings.twitter_url && (
                <SocialIcon href={settings.twitter_url} label="X">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M4 4l7.2 9.4L4 20h2.4l5.6-6.2 4.5 6.2H20l-7.4-9.6L19.6 4h-2.4l-5 5.5L8.2 4H4z" />
                  </svg>
                </SocialIcon>
              )}
              {settings.show_youtube && settings.youtube_url && (
                <SocialIcon href={settings.youtube_url} label="YouTube">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M21.8 8.001a2.75 2.75 0 0 0-1.94-1.96C18.88 5.5 12 5.5 12 5.5s-6.88 0-8.86.46A2.75 2.75 0 0 0 1.2 8.05 28.3 28.3 0 0 0 .75 12a28.3 28.3 0 0 0 .45 3.99 2.75 2.75 0 0 0 1.94 2.17c1.98.47 8.86.47 8.86.47s6.88 0 8.86-.47a2.75 2.75 0 0 0 1.94-2.17 28.3 28.3 0 0 0 .45-3.99 28.3 28.3 0 0 0-.45-3.99zM10 15.25v-6.5L15.2 12 10 15.25z" />
                  </svg>
                </SocialIcon>
              )}
              {settings.show_whatsapp && settings.whatsapp_url && (
                <SocialIcon href={settings.whatsapp_url} label="WhatsApp">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M20.52 3.48A11.84 11.84 0 0 0 12.06 0C5.92 0 .93 4.99.93 11.13c0 1.96.51 3.87 1.48 5.56L0 24l7.47-1.96a11.7 11.7 0 0 0 5.59 1.43h.01c6.14 0 11.13-4.99 11.13-11.13a11.06 11.06 0 0 0-2.68-7.86zM12.07 21.1h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-4.45 1.17 1.19-4.33-.22-.36a9.43 9.43 0 1 1 8.63 5.04zm5.18-7.07c-.28-.14-1.65-.81-1.9-.9-.25-.1-.43-.14-.61.14-.18.28-.7.9-.86 1.08-.16.18-.32.2-.6.07a7.26 7.26 0 0 1-2.14-1.32 8.09 8.09 0 0 1-1.48-1.85c-.16-.28 0-.43.12-.57.12-.12.28-.32.42-.48.14-.16.18-.28.28-.46.1-.18.05-.34-.02-.48-.07-.14-.61-1.47-.84-2.01-.22-.52-.45-.45-.61-.46h-.52a1 1 0 0 0-.72.34A3.05 3.05 0 0 0 8 9.81a5.3 5.3 0 0 0 1.12 2.38 12.1 12.1 0 0 0 4.65 4.11c.65.28 1.16.45 1.56.57.66.21 1.26.18 1.74.11.53-.08 1.65-.67 1.88-1.32.23-.65.23-1.21.16-1.32-.07-.11-.25-.18-.53-.32z" />
                  </svg>
                </SocialIcon>
              )}
              {settings.show_linkedin && settings.linkedin_url && (
                <SocialIcon href={settings.linkedin_url} label="LinkedIn">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M6.5 8.5h3V21h-3V8.5zM8 3.25a1.75 1.75 0 1 1-1.75 1.75A1.75 1.75 0 0 1 8 3.25zM14.5 8.5h2.9v1.7h.04c.4-.75 1.4-1.55 2.9-1.55 3.1 0 3.66 2.04 3.66 4.7V21h-3.2v-6.4c0-1.53 0-3.5-2.14-3.5-2.14 0-2.46 1.67-2.46 3.4V21h-3.2V8.5z" />
                  </svg>
                </SocialIcon>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-3 text-sm text-white/60">
            <Link to={`/${shopSlug}/privacy`} className="min-h-12 py-3 hover:text-[color:var(--color-accent)]">
              Privacy Policy
            </Link>
            <Link to={`/${shopSlug}/terms`} className="min-h-12 py-3 hover:text-[color:var(--color-accent)]">
              Terms of Service
            </Link>
            <Link to={`/${shopSlug}/cookies`} className="min-h-12 py-3 hover:text-[color:var(--color-accent)]">
              Cookie Policy
            </Link>
            <button
              type="button"
              className="min-h-12 py-3 text-left hover:text-[color:var(--color-accent)]"
              onClick={() => {
                setCookieForce(true);
                window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
              }}
            >
              Manage cookie preferences
            </button>
          </div>
        </div>
        <div className="mx-auto mt-10 max-w-7xl border-t border-white/10 pt-8 text-center text-sm text-white/45">
          <a
            href="https://pivotparlor.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[color:var(--color-accent)] hover:underline"
          >
            Powered by Pivot Parlor
          </a>
          <p className="mt-2">
            © {new Date().getFullYear()} {site.shop_name}
          </p>
        </div>
      </footer>

      <CookieConsentPanel
        forceOpen={cookieForce}
        onClose={() => setCookieForce(false)}
      />

      <button
        type="button"
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[color:var(--color-accent)] text-2xl text-black shadow-xl"
        aria-label="Open chat"
        onClick={() => setChatOpen((v) => !v)}
      >
        💬
      </button>
      {chatOpen && (
        <div className="fixed bottom-24 right-6 z-50 w-[min(100vw-2rem,22rem)] rounded-2xl border border-white/10 bg-[#111] p-2 shadow-2xl">
          <ChatWidget shopSlug={shopSlug} />
        </div>
      )}
    </div>
  );
}
