import { Link } from "@remix-run/react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ShopSettings, SiteData } from "~/components/commercialSiteTypes";
import { ShopSiteCookieConsent } from "~/components/ShopSiteCookieConsent";

function trimMediaUrl(url: string | undefined | null): string {
  if (typeof url !== "string") return "";
  return url.trim();
}

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

function shopNameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase() || "?";
}

function SocialIcon({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
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

function navLinkClass(active: boolean) {
  return active
    ? "pp-heading text-sm font-semibold text-[color:var(--color-accent)]"
    : "pp-heading text-sm font-medium text-white/85 transition hover:text-[color:var(--color-accent)]";
}

export type CommercialShopChromeProps = {
  site: SiteData;
  settings: ShopSettings;
  shopSlug: string;
  /** When true, highlights Home (e.g. on landing). */
  homeActive?: boolean;
  children: ReactNode;
};

export function CommercialShopChrome({
  site,
  settings,
  shopSlug,
  homeActive = false,
  children,
}: CommercialShopChromeProps) {
  const [navOpen, setNavOpen] = useState(false);
  const [cookieForce, setCookieForce] = useState(false);
  const closeNav = () => setNavOpen(false);

  const bookingEnabled = settings.booking_enabled !== false;

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
  } as CSSProperties;

  const logoSrc = trimMediaUrl(site.logo_url);

  const ig = settings.instagram_url?.trim();
  const fb = settings.facebook_url?.trim();
  const tt = settings.tiktok_url?.trim();
  const tw = settings.twitter_url?.trim();
  const yt = settings.youtube_url?.trim();
  const wa = settings.whatsapp_url?.trim();
  const li = settings.linkedin_url?.trim();

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

      <header className="sticky top-0 z-40 border-b border-white/10 bg-[color:var(--color-brand)]/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <Link to={`/${shopSlug}`} className="flex min-h-12 min-w-0 shrink-0 items-center gap-3" onClick={closeNav}>
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
            <span className="pp-heading truncate text-[clamp(1rem,2.5vw,1.25rem)] font-semibold text-white">
              {site.shop_name}
            </span>
          </Link>

          <nav className="hidden flex-1 items-center justify-center gap-8 lg:gap-10 md:flex" aria-label="Primary">
            <Link to={`/${shopSlug}`} className={navLinkClass(homeActive)} onClick={closeNav}>
              Home
            </Link>
            <Link to={`/${shopSlug}#services`} className={navLinkClass(false)} onClick={closeNav}>
              Services
            </Link>
            {bookingEnabled ? (
              <Link to={`/${shopSlug}/book`} className={navLinkClass(false)} onClick={closeNav}>
                Book
              </Link>
            ) : null}
          </nav>

          <div className="hidden items-center gap-4 md:flex">
            {bookingEnabled ? (
              <Link
                to={`/${shopSlug}/book`}
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-[color:var(--color-accent)] px-6 pp-heading text-sm font-semibold text-black"
              >
                Book Now →
              </Link>
            ) : (
              <Link
                to={`/${shopSlug}#services`}
                className="inline-flex min-h-12 items-center justify-center rounded-lg bg-[color:var(--color-accent)] px-6 pp-heading text-sm font-semibold text-black"
              >
                View services →
              </Link>
            )}
          </div>

          <button
            type="button"
            className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-lg border border-white/20 md:hidden"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
          >
            <span className="text-2xl">☰</span>
          </button>
        </div>

        {navOpen ? (
          <div className="fixed inset-0 z-50 flex flex-col bg-[color:var(--color-brand)] md:hidden">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <span className="pp-heading truncate text-lg">{site.shop_name}</span>
              <button
                type="button"
                className="min-h-12 min-w-12 text-2xl"
                aria-label="Close menu"
                onClick={closeNav}
              >
                ×
              </button>
            </div>
            <nav className="flex flex-1 flex-col gap-1 p-6" aria-label="Mobile">
              <Link
                to={`/${shopSlug}`}
                className="min-h-12 rounded-lg px-4 py-3 text-left font-medium text-white/90"
                onClick={closeNav}
              >
                Home
              </Link>
              <Link
                to={`/${shopSlug}#services`}
                className="min-h-12 rounded-lg px-4 py-3 text-left font-medium text-white/90"
                onClick={closeNav}
              >
                Services
              </Link>
              {bookingEnabled ? (
                <Link
                  to={`/${shopSlug}/book`}
                  className="min-h-12 rounded-lg px-4 py-3 text-left font-medium text-white/90"
                  onClick={closeNav}
                >
                  Book
                </Link>
              ) : null}
              {bookingEnabled ? (
                <Link
                  to={`/${shopSlug}/book`}
                  className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-[color:var(--color-accent)] px-6 pp-heading font-semibold text-black"
                  onClick={closeNav}
                >
                  Book Now →
                </Link>
              ) : (
                <Link
                  to={`/${shopSlug}#services`}
                  className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-[color:var(--color-accent)] px-6 pp-heading font-semibold text-black"
                  onClick={closeNav}
                >
                  View services →
                </Link>
              )}
            </nav>
          </div>
        ) : null}
      </header>

      {children}

      <footer className="border-t border-white/10 bg-black/30 px-4 py-12 md:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-md">
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
                {settings.show_instagram && ig ? (
                  <SocialIcon href={ig} label="Instagram">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7zm5 3.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 0 1 12 7.5zm0 2A2.5 2.5 0 1 0 14.5 12 2.5 2.5 0 0 0 12 9.5zm5.25-3a1.25 1.25 0 1 1-1.25 1.25A1.25 1.25 0 0 1 17.25 6.5z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_facebook && fb ? (
                  <SocialIcon href={fb} label="Facebook">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M13.5 22v-9h3l.5-4h-3.5V7c0-1 .6-1.5 1.8-1.5H17V2h-3c-3.2 0-5 2-5 5v2H7v4h2v9h4.5z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_tiktok && tt ? (
                  <SocialIcon href={tt} label="TikTok">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M16.6 5.82s.51.5.81 1.32l.01-.01-1.05-.36c.11 1.08.01 2.12-.01 2.12-.33-.02-2.02-.67-3.4-2.12v8.5A3.5 3.5 0 1 1 9 12.32V9.66a5.5 5.5 0 0 0 1 .06c.55-.02 1.09-.18 1.58-.45v2.13c.65.38 1.35.6 2.08.64 1.02.06 2.02-.28 2.94-.94z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_twitter && tw ? (
                  <SocialIcon href={tw} label="X">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M4 4l7.2 9.4L4 20h2.4l5.6-6.2 4.5 6.2H20l-7.4-9.6L19.6 4h-2.4l-5 5.5L8.2 4H4z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_youtube && yt ? (
                  <SocialIcon href={yt} label="YouTube">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M21.8 8.001a2.75 2.75 0 0 0-1.94-1.96C18.88 5.5 12 5.5 12 5.5s-6.88 0-8.86.46A2.75 2.75 0 0 0 1.2 8.05 28.3 28.3 0 0 0 .75 12a28.3 28.3 0 0 0 .45 3.99 2.75 2.75 0 0 0 1.94 2.17c1.98.47 8.86.47 8.86.47s6.88 0 8.86-.47a2.75 2.75 0 0 0 1.94-2.17 28.3 28.3 0 0 0 .45-3.99 28.3 28.3 0 0 0-.45-3.99zM10 15.25v-6.5L15.2 12 10 15.25z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_whatsapp && wa ? (
                  <SocialIcon href={wa} label="WhatsApp">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M20.52 3.48A11.84 11.84 0 0 0 12.06 0C5.92 0 .93 4.99.93 11.13c0 1.96.51 3.87 1.48 5.56L0 24l7.47-1.96a11.7 11.7 0 0 0 5.59 1.43h.01c6.14 0 11.13-4.99 11.13-11.13a11.06 11.06 0 0 0-2.68-7.86zM12.07 21.1h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-4.45 1.17 1.19-4.33-.22-.36a9.43 9.43 0 1 1 8.63 5.04zm5.18-7.07c-.28-.14-1.65-.81-1.9-.9-.25-.1-.43-.14-.61.14-.18.28-.7.9-.86 1.08-.16.18-.32.2-.6.07a7.26 7.26 0 0 1-2.14-1.32 8.09 8.09 0 0 1-1.48-1.85c-.16-.28 0-.43.12-.57.12-.12.28-.32.42-.48.14-.16.18-.28.28-.46.1-.18.05-.34-.02-.48-.07-.14-.61-1.47-.84-2.01-.22-.52-.45-.45-.61-.46h-.52a1 1 0 0 0-.72.34A3.05 3.05 0 0 0 8 9.81a5.3 5.3 0 0 0 1.12 2.38 12.1 12.1 0 0 0 4.65 4.11c.65.28 1.16.45 1.56.57.66.21 1.26.18 1.74.11.53-.08 1.65-.67 1.88-1.32.23-.65.23-1.21.16-1.32-.07-.11-.25-.18-.53-.32z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_linkedin && li ? (
                  <SocialIcon href={li} label="LinkedIn">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M6.5 8.5h3V21h-3V8.5zM8 3.25a1.75 1.75 0 1 1-1.75 1.75A1.75 1.75 0 0 1 8 3.25zM14.5 8.5h2.9v1.7h.04c.4-.75 1.4-1.55 2.9-1.55 3.1 0 3.66 2.04 3.66 4.7V21h-3.2v-6.4c0-1.53 0-3.5-2.14-3.5-2.14 0-2.46 1.67-2.46 3.4V21h-3.2V8.5z" />
                    </svg>
                  </SocialIcon>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <nav
                className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-8"
                aria-label="Footer"
              >
                <Link
                  to={`/${shopSlug}`}
                  className="min-h-11 py-2 text-sm text-white/75 transition hover:text-[color:var(--color-accent)]"
                >
                  Home
                </Link>
                <Link
                  to={`/${shopSlug}#services`}
                  className="min-h-11 py-2 text-sm text-white/75 transition hover:text-[color:var(--color-accent)]"
                >
                  Services
                </Link>
                <Link
                  to={`/${shopSlug}/privacy`}
                  className="min-h-11 py-2 text-sm text-white/75 transition hover:text-[color:var(--color-accent)]"
                >
                  Privacy Policy
                </Link>
                <Link
                  to={`/${shopSlug}/terms`}
                  className="min-h-11 py-2 text-sm text-white/75 transition hover:text-[color:var(--color-accent)]"
                >
                  Terms of Service
                </Link>
                <Link
                  to={`/${shopSlug}/cookies`}
                  className="min-h-11 py-2 text-sm text-white/75 transition hover:text-[color:var(--color-accent)]"
                >
                  Cookie Policy
                </Link>
              </nav>
              <button
                type="button"
                className="min-h-11 w-fit text-left text-sm text-white/60 hover:text-[color:var(--color-accent)]"
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
        </div>
      </footer>

      <ShopSiteCookieConsent forceOpen={cookieForce} onClose={() => setCookieForce(false)} />

      <button
        type="button"
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-[color:var(--color-accent)] text-2xl text-black shadow-xl"
        aria-label="Chat — coming soon"
      >
        💬
      </button>
    </div>
  );
}
