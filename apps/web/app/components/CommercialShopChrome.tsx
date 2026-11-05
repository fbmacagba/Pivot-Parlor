import { Link } from "@remix-run/react";
import { MessageCircle, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  resolveSiteTheme,
  resolveCuratedFont,
  curatedFontStack,
  isPortfolioDemoShop,
  portfolioDemoReply,
} from "@repo/utils";
import type { ShopSettings, SiteData } from "~/components/commercialSiteTypes";
import { ShopSiteCookieConsent } from "~/components/ShopSiteCookieConsent";
import { useModalA11y } from "~/lib/useModalA11y";
import { useScrolledPastHero } from "~/lib/useScrolledPastHero";
import { MobileBookingBar } from "~/components/MobileBookingBar";
import { InstallAppButton } from "~/components/InstallAppButton";
import "~/components/shop-chrome.css";

const CHATBOT_CHAT_URL =
  "https://pivot-parlor-chatbot.bmorris0565.workers.dev/chat";

type ChatTurn = { role: "user" | "assistant"; content: string };

function isSafeChatHref(href: string): boolean {
  const t = href.trim();
  if (!t) return false;
  if (t.startsWith("/") && !t.startsWith("//")) return true;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function renderMarkdownLinks(text: string): ReactNode {
  const re = /\[([^\]]*)\]\(([^)]*)\)/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const label = m[1] ?? "";
    const href = (m[2] ?? "").trim();
    if (isSafeChatHref(href)) {
      parts.push(
        <a
          key={`chat-md-${key++}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline text-[color:var(--st-accent-text)]"
        >
          {label}
        </a>,
      );
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  if (parts.length === 0) return text;
  if (parts.length === 1) return parts[0];
  return <>{parts}</>;
}

function trimMediaUrl(url: string | undefined | null): string {
  if (typeof url !== "string") return "";
  return url.trim();
}

function shopNameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase() || "?";
}

/** Returns true if a service name/category looks like a retail product. */
function looksLikeProduct(name: string, category?: string | null): boolean {
  if (category?.toLowerCase() === "product") return true;
  return /\b(shampoo|conditioner|pomade|wax|gel|oil|serum|cream|balm|spray|tonic|beard|hair product|grooming kit|aftershave|moisturiser|moisturizer|clay|paste|putty|powder|treatment kit|retail)\b/i.test(
    name,
  );
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
      className="flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--st-chip)] text-[color:var(--st-ink)] transition hover:bg-[color:var(--st-accent-20)] hover:text-[color:var(--st-accent-text)]"
    >
      {children}
    </a>
  );
}

function navLinkClass(active: boolean) {
  return active
    ? "pp-heading text-sm font-semibold text-[color:var(--st-accent-text)]"
    : "pp-heading text-sm font-medium text-[color:var(--st-ink-85)] transition hover:text-[color:var(--st-accent-text)]";
}

export type CommercialShopChromeProps = {
  site: SiteData;
  settings: ShopSettings;
  shopSlug: string;
  homeActive?: boolean;
  children: ReactNode;
  /**
   * Services already loaded by the SSR route loader.
   * Used to populate the chatbot welcome chips — no extra fetch needed.
   */
  services?: { name: string; price_gbp: number; category?: string | null }[];
  /**
   * Render the phone-only sticky "Book now" bar (default true). Pages whose
   * own flow owns the primary CTA (/book, /confirm, /waitlist) pass false.
   */
  bookingBar?: boolean;
};

export function CommercialShopChrome({
  site,
  settings,
  shopSlug,
  homeActive = false,
  children,
  services = [],
  bookingBar = true,
}: CommercialShopChromeProps) {
  const [navOpen, setNavOpen] = useState(false);
  const [cookieForce, setCookieForce] = useState(false);
  const [cookieHeight, setCookieHeight] = useState(0);
  const demo = isPortfolioDemoShop(shopSlug);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatTurn[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  // Track whether the visitor has interacted (sent a message or tapped a chip)
  const [chatStarted, setChatStarted] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const turnstileWidgetId = useRef<string | null>(null);

  // Turnstile invisible widget — obtain a fresh token before each chat message
  useEffect(() => {
    if (demo || typeof window === "undefined") return;
    if ((window as unknown as { turnstile?: unknown }).turnstile) return; // already loaded
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }, [demo]);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const closeNav = () => setNavOpen(false);

  // Mobile menu is a fullscreen modal: trap Tab, close on Escape, lock
  // scroll, restore focus to the burger button on close.
  const navDialogRef = useModalA11y<HTMLDivElement>({
    active: navOpen,
    onClose: closeNav,
  });

  const shopId = site.shop_id?.trim() ?? "";

  // Separate treatments from products for the welcome chips
  const treatmentServices = services.filter(
    (s) => !looksLikeProduct(s.name, s.category),
  );
  const hasProducts = services.some((s) =>
    looksLikeProduct(s.name, s.category),
  );

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, chatSending, chatOpen]);

  const sendChatMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatSending || !shopId) return;
    if (demo) {
      setChatStarted(true);
      setChatMessages(previous => [...previous, { role: "user", content: trimmed.slice(0, 2000) },
        { role: "assistant", content: portfolioDemoReply(trimmed) }]);
      return;
    }

    // Get Turnstile token if widget is available (gracefully skip if not configured)
    let turnstileToken = "";
    try {
      const ts = (
        window as unknown as {
          turnstile?: {
            execute: (
              id: string,
              opts: { callback: (t: string) => void },
            ) => void;
          };
        }
      ).turnstile;
      if (ts && turnstileWidgetId.current) {
        turnstileToken = await new Promise<string>((resolve) => {
          ts.execute(turnstileWidgetId.current!, { callback: resolve });
          setTimeout(() => resolve(""), 3000); // fallback after 3s
        });
      }
    } catch {
      /* non-fatal — proceed without token */
    }

    // Mark as started so the welcome UI disappears
    setChatStarted(true);

    const historyPayload = chatMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    setChatMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setChatSending(true);
    try {
      const res = await fetch(CHATBOT_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId,
          message: trimmed,
          history: historyPayload,
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });
      if (res.status === 429) {
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              "You've sent too many messages. Please wait a few minutes before trying again.",
          },
        ]);
        return;
      }
      const data = (await res.json()) as { reply?: string };
      const reply =
        typeof data.reply === "string" && data.reply.trim()
          ? data.reply.trim()
          : "Sorry — something went wrong. Please try again.";
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply },
      ]);
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "Sorry — we couldn't reach the assistant. Please try again in a moment.",
        },
      ]);
    } finally {
      setChatSending(false);
    }
  };

  const handleClose = () => {
    setChatOpen(false);
    setChatMessages([]);
    setChatStarted(false);
    setChatSending(false);
  };

  // Chat panel is a non-modal floating window: Escape closes and focus
  // returns to the launcher, but Tab is not trapped and scroll stays free.
  const chatDialogRef = useModalA11y<HTMLDivElement>({
    active: chatOpen,
    onClose: handleClose,
    lockScroll: false,
    trapTabs: false,
  });

  const bookingEnabled = settings.booking_enabled !== false;

  // Phone-only bottom bar: shown once the hero (or the first viewport, on
  // pages without one) has scrolled away. Never present in SSR markup.
  const { sentinelRef, pastHero } = useScrolledPastHero(bookingBar);

  // The bar and the menu are phone-only fixed layers at the same z-index; the
  // bar yields whenever the menu is open, and the chat-launcher lift follows it.
  const barShown = pastHero && !navOpen;

  // Fonts resolve onto the curated SELF-HOSTED set (WS-6 item 5 / LEG-5) —
  // exact matches keep their family; unknown legacy names fall to the role's
  // default via the stored heading_style hint. No Google Fonts request.
  const headingFont = resolveCuratedFont(
    site.font_heading,
    "heading",
    site.heading_style,
  );
  const bodyFont = resolveCuratedFont(site.font_body, "body");
  const fontHeadingStack = curatedFontStack(headingFont.family);
  const fontBodyStack = curatedFontStack(bodyFont.family);

  // Honour the generated heading_weight (WS-6 item 5) — ONLY for v2 sites
  // that carry one: the `.pp-commercial h1..` rule outweighs Tailwind's
  // per-element font classes, so emitting it unconditionally would restyle
  // every legacy site's headings.
  const headingWeightRaw = site.heading_weight?.trim() ?? "";
  const headingWeight =
    (site.design_version ?? 1) >= 2 && /^[1-9]00$/.test(headingWeightRaw)
      ? headingWeightRaw
      : null;

  // Palette-driven theme tokens (WS-6 item 3+4). Legacy sites
  // (design_version < 2 or no palette) resolve to the exact colours this
  // component used to hardcode; v2 sites follow their generated palette,
  // including light schemes, with WCAG-guarded ink and accent.
  const theme = resolveSiteTheme({
    color_primary: site.color_primary,
    color_accent: site.color_accent,
    palette: site.palette,
    design_version: site.design_version,
    shop_id: site.shop_id,
  });

  const rootStyle = {
    ...theme.vars,
    // Native form controls (date/select popups, scrollbars) follow the
    // palette's scheme instead of the html-level dark default, so light
    // shop sites get light-chrome controls.
    colorScheme: theme.scheme,
    "--pp-font-heading": fontHeadingStack,
    "--pp-font-body": fontBodyStack,
  } as CSSProperties;

  const logoSrc = trimMediaUrl(site.logo_url);

  const ig = settings.instagram_url?.trim();
  const gbp = settings.google_business_url?.trim();
  const fb = settings.facebook_url?.trim();
  const tt = settings.tiktok_url?.trim();
  const tw = settings.twitter_url?.trim();
  const yt = settings.youtube_url?.trim();
  const wa = settings.whatsapp_url?.trim();
  const li = settings.linkedin_url?.trim();

  return (
    <div
      className={`pp-commercial relative min-h-screen bg-[color:var(--st-bg)] text-[color:var(--st-ink)]${barShown ? " pp-bar-shown" : ""}${demo ? " pp-portfolio-demo" : ""}`}
      style={{ ...rootStyle, fontFamily: "var(--pp-font-body)", "--pp-cookie-lift": `${cookieHeight}px` } as CSSProperties}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `.pp-commercial h1,.pp-commercial h2,.pp-commercial h3,.pp-commercial .pp-heading{font-family:var(--pp-font-heading);${headingWeight ? `font-weight:${headingWeight};` : ""}}@keyframes pp-chat-bounce{0%,80%,100%{transform:translateY(0);opacity:.45}40%{transform:translateY(-5px);opacity:1}}`,
        }}
      />

      {bookingBar ? <div ref={sentinelRef} className="pp-bar-sentinel" aria-hidden /> : null}

      <header className="pp-safe-top pp-safe-x sticky top-0 z-40 border-b border-[color:var(--st-line-10)] bg-[color:var(--st-header)] backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6">
          <Link
            to={`/${shopSlug}`}
            className="flex min-h-12 min-w-0 items-center gap-3"
            onClick={closeNav}
          >
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
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-15)] pp-heading text-sm font-bold text-[color:var(--st-accent-text)]"
                aria-hidden
              >
                {shopNameInitials(site.shop_name)}
              </span>
            )}
            <span className="pp-heading truncate text-[clamp(1rem,2.5vw,1.25rem)] font-semibold text-[color:var(--st-ink)]">
              {site.shop_name}
            </span>
          </Link>

          <nav
            className="hidden flex-1 items-center justify-center gap-8 lg:gap-10 md:flex"
            aria-label="Primary"
          >
            <Link
              to={`/${shopSlug}`}
              className={navLinkClass(homeActive)}
              onClick={closeNav}
            >
              Home
            </Link>
            <Link
              to={`/${shopSlug}#services`}
              className={navLinkClass(false)}
              onClick={closeNav}
            >
              Services
            </Link>
            {bookingEnabled ? (
              <Link
                to={`/${shopSlug}/book`}
                className={navLinkClass(false)}
                onClick={closeNav}
              >
                Book
              </Link>
            ) : null}
          </nav>

          <div className="hidden items-center gap-4 md:flex">
            {/* Single sign-in for owners, staff and customers — /login routes each
                role to its own dashboard (and sends already-signed-in visitors
                straight there). ?shop= powers a "back to shop" link on /login. */}
            {!demo && <Link
              to={`/login?shop=${encodeURIComponent(shopSlug)}`}
              className="inline-flex min-h-12 items-center justify-center rounded-[var(--st-r-sm)] border border-[color:var(--st-line-40)] px-5 pp-heading text-sm font-semibold text-[color:var(--st-ink-90)] transition hover:border-[color:var(--color-accent)] hover:text-[color:var(--st-accent-text)]"
            >
              Sign in
            </Link>}
            {bookingEnabled ? (
              <Link
                to={`/${shopSlug}/book`}
                className="inline-flex min-h-12 items-center justify-center rounded-[var(--st-r-sm)] bg-[color:var(--color-accent)] px-6 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition active:scale-[0.98]"
              >
                {demo ? "Try demo →" : "Book Now →"}
              </Link>
            ) : (
              <Link
                to={`/${shopSlug}#services`}
                className="inline-flex min-h-12 items-center justify-center rounded-[var(--st-r-sm)] bg-[color:var(--color-accent)] px-6 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition active:scale-[0.98]"
              >
                View services →
              </Link>
            )}
          </div>

          {/* Mobile: keep a booking CTA always in reach, plus the menu trigger. */}
          <div className="flex shrink-0 items-center gap-2 md:hidden">
            {bookingEnabled ? (
              <Link
                to={`/${shopSlug}/book`}
                onClick={closeNav}
                className="inline-flex min-h-12 items-center justify-center rounded-[var(--st-r-sm)] bg-[color:var(--color-accent)] px-4 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition active:scale-[0.98]"
              >
                {demo ? "Try demo" : "Book"}
              </Link>
            ) : null}
            <button
              type="button"
              className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-[var(--st-r-sm)] border border-[color:var(--st-line-20)]"
              aria-label="Open menu"
              onClick={() => setNavOpen(true)}
            >
              <span className="text-2xl">☰</span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile menu lives OUTSIDE the header: the header's backdrop-blur
          makes it the containing block for fixed descendants, which collapsed
          this inset-0 overlay to the header's own box (background only painted
          behind the top strip; the links rendered over the page). */}
      {navOpen ? (
        <div
          ref={navDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="pp-safe-top pp-safe-bottom pp-safe-x fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain bg-[color:var(--st-bg)] md:hidden"
        >
          <div className="flex items-center justify-between border-b border-[color:var(--st-line-10)] px-4 py-3">
            <span className="pp-heading truncate text-lg">
              {site.shop_name}
            </span>
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
              className="min-h-12 rounded-[var(--st-r-sm)] px-4 py-3 text-left font-medium text-[color:var(--st-ink-90)]"
              onClick={closeNav}
            >
              Home
            </Link>
            <Link
              to={`/${shopSlug}#services`}
              className="min-h-12 rounded-[var(--st-r-sm)] px-4 py-3 text-left font-medium text-[color:var(--st-ink-90)]"
              onClick={closeNav}
            >
              Services
            </Link>
            {bookingEnabled ? (
              <Link
                to={`/${shopSlug}/book`}
                className="min-h-12 rounded-[var(--st-r-sm)] px-4 py-3 text-left font-medium text-[color:var(--st-ink-90)]"
                onClick={closeNav}
              >
                Book
              </Link>
            ) : null}
            {/* Owner / staff / customer sign-in — /login role-routes each to its own dashboard. */}
            <div
              className="my-1 border-t border-[color:var(--st-line-10)]"
              aria-hidden
            />
            {!demo && <Link
              to={`/login?shop=${encodeURIComponent(shopSlug)}`}
              className="min-h-12 rounded-[var(--st-r-sm)] px-4 py-3 text-left font-medium text-[color:var(--st-ink-90)]"
              onClick={closeNav}
            >
              Sign in
            </Link>}
            {/* Install entry for the shop's PWA; renders nothing unless this
                device can install. Closing the menu first lets the native
                dialog (or the iOS walkthrough in the root-mounted prompt)
                take focus cleanly. */}
            <InstallAppButton shopName={site.shop_name} look="row" onActivate={closeNav} />
            {bookingEnabled ? (
              <Link
                to={`/${shopSlug}/book`}
                className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-[var(--st-r-sm)] bg-[color:var(--color-accent)] px-6 pp-heading font-semibold text-[color:var(--st-on-accent)] transition active:scale-[0.98]"
                onClick={closeNav}
              >
                {demo ? "Try demo →" : "Book Now →"}
              </Link>
            ) : (
              <Link
                to={`/${shopSlug}#services`}
                className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-[var(--st-r-sm)] bg-[color:var(--color-accent)] px-6 pp-heading font-semibold text-[color:var(--st-on-accent)] transition active:scale-[0.98]"
                onClick={closeNav}
              >
                View services →
              </Link>
            )}
          </nav>
        </div>
      ) : null}

      {demo ? <aside className="pp-demo-notice" aria-label="Demonstration notice">
        <strong>Interactive demonstration by BytesFX.</strong> Services, prices and team members are illustrative.
        No real appointments or payments are created. The sample assistant uses scripted replies.
      </aside> : null}
      {children}

      <footer className="border-t border-[color:var(--st-line-10)] bg-[color:var(--st-panel-3)] px-4 py-12 md:px-6">
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
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-15)] pp-heading text-sm font-bold text-[color:var(--st-accent-text)]"
                    aria-hidden
                  >
                    {shopNameInitials(site.shop_name)}
                  </span>
                )}
                <span className="pp-heading text-lg font-semibold">
                  {site.shop_name}
                </span>
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                {settings.show_instagram && ig ? (
                  <SocialIcon href={ig} label="Instagram">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7zm5 3.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 0 1 12 7.5zm0 2A2.5 2.5 0 1 0 14.5 12 2.5 2.5 0 0 0 12 9.5zm5.25-3a1.25 1.25 0 1 1-1.25 1.25A1.25 1.25 0 0 1 17.25 6.5z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_facebook && fb ? (
                  <SocialIcon href={fb} label="Facebook">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M13.5 22v-9h3l.5-4h-3.5V7c0-1 .6-1.5 1.8-1.5H17V2h-3c-3.2 0-5 2-5 5v2H7v4h2v9h4.5z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_tiktok && tt ? (
                  <SocialIcon href={tt} label="TikTok">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M16.6 5.82s.51.5.81 1.32l.01-.01-1.05-.36c.11 1.08.01 2.12-.01 2.12-.33-.02-2.02-.67-3.4-2.12v8.5A3.5 3.5 0 1 1 9 12.32V9.66a5.5 5.5 0 0 0 1 .06c.55-.02 1.09-.18 1.58-.45v2.13c.65.38 1.35.6 2.08.64 1.02.06 2.02-.28 2.94-.94z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_twitter && tw ? (
                  <SocialIcon href={tw} label="X">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M4 4l7.2 9.4L4 20h2.4l5.6-6.2 4.5 6.2H20l-7.4-9.6L19.6 4h-2.4l-5 5.5L8.2 4H4z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_youtube && yt ? (
                  <SocialIcon href={yt} label="YouTube">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M21.8 8.001a2.75 2.75 0 0 0-1.94-1.96C18.88 5.5 12 5.5 12 5.5s-6.88 0-8.86.46A2.75 2.75 0 0 0 1.2 8.05 28.3 28.3 0 0 0 .75 12a28.3 28.3 0 0 0 .45 3.99 2.75 2.75 0 0 0 1.94 2.17c1.98.47 8.86.47 8.86.47s6.88 0 8.86-.47a2.75 2.75 0 0 0 1.94-2.17 28.3 28.3 0 0 0 .45-3.99 28.3 28.3 0 0 0-.45-3.99zM10 15.25v-6.5L15.2 12 10 15.25z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_whatsapp && wa ? (
                  <SocialIcon href={wa} label="WhatsApp">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M20.52 3.48A11.84 11.84 0 0 0 12.06 0C5.92 0 .93 4.99.93 11.13c0 1.96.51 3.87 1.48 5.56L0 24l7.47-1.96a11.7 11.7 0 0 0 5.59 1.43h.01c6.14 0 11.13-4.99 11.13-11.13a11.06 11.06 0 0 0-2.68-7.86zM12.07 21.1h-.01a9.4 9.4 0 0 1-4.8-1.32l-.34-.2-4.45 1.17 1.19-4.33-.22-.36a9.43 9.43 0 1 1 8.63 5.04zm5.18-7.07c-.28-.14-1.65-.81-1.9-.9-.25-.1-.43-.14-.61.14-.18.28-.7.9-.86 1.08-.16.18-.32.2-.6.07a7.26 7.26 0 0 1-2.14-1.32 8.09 8.09 0 0 1-1.48-1.85c-.16-.28 0-.43.12-.57.12-.12.28-.32.42-.48.14-.16.18-.28.28-.46.1-.18.05-.34-.02-.48-.07-.14-.61-1.47-.84-2.01-.22-.52-.45-.45-.61-.46h-.52a1 1 0 0 0-.72.34A3.05 3.05 0 0 0 8 9.81a5.3 5.3 0 0 0 1.12 2.38 12.1 12.1 0 0 0 4.65 4.11c.65.28 1.16.45 1.56.57.66.21 1.26.18 1.74.11.53-.08 1.65-.67 1.88-1.32.23-.65.23-1.21.16-1.32-.07-.11-.25-.18-.53-.32z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_google_business && gbp ? (
                  <SocialIcon href={gbp} label="Google Business">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.94-.49-7-3.85-7-7.93s3.06-7.44 7-7.93v15.86zm2-15.86c1.03.13 2 .45 2.87.93H13v-.93zM13 7h5.24c.25.31.48.65.68 1H13V7zm0 3h6.74c.08.32.15.65.19.99L13 11V10zm0 3l6.93-.01c-.05.34-.12.67-.21 1H13v-.99zM13 16h6c-.31.7-.7 1.35-1.17 1.93H13V16zm0 4.93V19h3.48c-1 .58-2.12.9-3.28.96L13 20.93z" />
                    </svg>
                  </SocialIcon>
                ) : null}
                {settings.show_linkedin && li ? (
                  <SocialIcon href={li} label="LinkedIn">
                    <svg
                      className="h-6 w-6"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      aria-hidden
                    >
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
                  className="min-h-11 py-2 text-sm text-[color:var(--st-ink-75)] transition hover:text-[color:var(--st-accent-text)]"
                >
                  Home
                </Link>
                <Link
                  to={`/${shopSlug}#services`}
                  className="min-h-11 py-2 text-sm text-[color:var(--st-ink-75)] transition hover:text-[color:var(--st-accent-text)]"
                >
                  Services
                </Link>
                <Link
                  to={`/${shopSlug}/privacy`}
                  className="min-h-11 py-2 text-sm text-[color:var(--st-ink-75)] transition hover:text-[color:var(--st-accent-text)]"
                >
                  Privacy Policy
                </Link>
                <Link
                  to={`/${shopSlug}/terms`}
                  className="min-h-11 py-2 text-sm text-[color:var(--st-ink-75)] transition hover:text-[color:var(--st-accent-text)]"
                >
                  Terms of Service
                </Link>
                <Link
                  to={`/${shopSlug}/cookies`}
                  className="min-h-11 py-2 text-sm text-[color:var(--st-ink-75)] transition hover:text-[color:var(--st-accent-text)]"
                >
                  Cookie Policy
                </Link>
              </nav>
              <button
                type="button"
                className="min-h-11 w-fit text-left text-sm text-[color:var(--st-ink-60)] hover:text-[color:var(--st-accent-text)]"
                onClick={() => {
                  setCookieForce(true);
                  window.scrollTo({
                    top: document.body.scrollHeight,
                    behavior: "smooth",
                  });
                }}
              >
                Manage cookie preferences
              </button>
            </div>
          </div>

          <div className="mx-auto mt-10 max-w-7xl border-t border-[color:var(--st-line-10)] pt-8 text-center text-sm text-[color:var(--st-ink-45)]">
            <a
              href="https://pivotparlor.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[color:var(--st-accent-text)] hover:underline"
            >
              Powered by Pivot Parlor
            </a>
            <p className="mt-2">
              © {new Date().getFullYear()} {site.shop_name}
            </p>
          </div>
        </div>
      </footer>

      <ShopSiteCookieConsent
        forceOpen={cookieForce}
        onClose={() => setCookieForce(false)}
        onHeightChange={setCookieHeight}
      />

      {bookingBar ? (
        <MobileBookingBar shopSlug={shopSlug} bookingEnabled={bookingEnabled} visible={barShown} />
      ) : null}

      {chatOpen ? (
        <div
          ref={chatDialogRef}
          className="pp-chat-panel flex w-[360px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-[var(--st-r-lg)] border border-[color:var(--st-line-15)] bg-[color:var(--st-bg)] shadow-2xl"
          role="dialog"
          aria-label={demo ? "Scripted demonstration assistant" : `Chat with ${site.shop_name}'s AI assistant`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <header className="flex shrink-0 items-start gap-3 border-b border-[color:var(--st-line-10)] px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {logoSrc ? (
                <img
                  src={logoSrc}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-[color:var(--st-accent-50)] bg-[color:var(--st-accent-15)] pp-heading text-xs font-bold text-[color:var(--st-accent-text)]"
                  aria-hidden
                >
                  {shopNameInitials(site.shop_name)}
                </span>
              )}
              <div className="min-w-0">
                <p className="pp-heading truncate text-sm font-semibold text-[color:var(--st-ink)]">
                  {site.shop_name}
                </p>
                <p className="text-xs text-[color:var(--st-ink-55)]">
                  {demo ? "Sample assistant · Scripted replies" : "AI assistant · Ask us anything"}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--st-r-sm)] text-[color:var(--st-ink-80)] transition hover:bg-[color:var(--st-chip)] hover:text-[color:var(--st-ink)]"
              aria-label="Close chat"
              onClick={handleClose}
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
          </header>

          {/* Body */}
          <div
            ref={chatScrollRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 space-y-3"
          >
            {/* Welcome state: greeting + service chips (shown before any message is sent) */}
            {!chatStarted && (
              <div className="space-y-3">
                {/* Greeting bubble */}
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-[color:var(--st-bubble)] px-3 py-2 text-sm text-[color:var(--st-ink-95)]">
                    {demo ? "Try a sample conversation about the example services, prices or team. Replies stay in this browser. Please do not enter personal details." : `Hi! I'm ${site.shop_name}'s AI assistant. What can I help you with?`}
                  </div>
                </div>

                {/* Service chips */}
                {treatmentServices.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-[color:var(--st-ink-40)] px-1">
                      Our services
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {treatmentServices.map((svc) => (
                        <button
                          key={svc.name}
                          type="button"
                          onClick={() =>
                            sendChatMessage(`Tell me about ${svc.name}`)
                          }
                          className="flex items-center justify-between rounded-[var(--st-r-md)] border border-[color:var(--st-line-15)] bg-[color:var(--st-card-5)] px-3 py-2 text-left text-sm transition hover:border-[color:var(--st-accent-50)] hover:bg-[color:var(--st-chip)] active:scale-[0.98]"
                        >
                          <span className="font-medium text-[color:var(--st-ink-90)]">
                            {svc.name}
                          </span>
                          <span className="ml-3 shrink-0 font-semibold text-[color:var(--st-accent-text)]">
                            £
                            {Number.isInteger(Number(svc.price_gbp))
                              ? Number(svc.price_gbp).toFixed(0)
                              : Number(svc.price_gbp).toFixed(2)}
                          </span>
                        </button>
                      ))}
                      {hasProducts && (
                        <button
                          type="button"
                          onClick={() =>
                            sendChatMessage(
                              "What grooming products do you sell?",
                            )
                          }
                          className="flex items-center justify-between rounded-[var(--st-r-md)] border border-[color:var(--st-line-15)] bg-[color:var(--st-card-5)] px-3 py-2 text-left text-sm transition hover:border-[color:var(--st-accent-50)] hover:bg-[color:var(--st-chip)] active:scale-[0.98]"
                        >
                          <span className="font-medium text-[color:var(--st-ink-90)]">
                            Grooming products
                          </span>
                          <span className="ml-3 shrink-0 text-xs text-[color:var(--st-ink-50)]">
                            In-store
                          </span>
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-[color:var(--st-ink-30)] px-1 pt-1">
                      Tap a service or type your question below
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Conversation messages (shown after first interaction) */}
            {chatMessages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[color:var(--color-accent)] px-3 py-2 text-sm text-[color:var(--st-on-accent)]">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-[color:var(--st-bubble)] px-3 py-2 text-sm text-[color:var(--st-ink-95)]">
                    {renderMarkdownLinks(m.content)}
                  </div>
                </div>
              ),
            )}

            {chatSending ? (
              <div
                className="flex justify-start"
                aria-live="polite"
                aria-label="Assistant is typing"
              >
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-[color:var(--st-bubble)] px-4 py-3">
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      className="h-2 w-2 rounded-full bg-[color:var(--st-ink-55)]"
                      style={{
                        animation: "pp-chat-bounce 1.2s ease-in-out infinite",
                        animationDelay: `${dot * 0.2}s`,
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {!shopId ? (
            <p className="shrink-0 border-t border-[color:var(--st-line-10)] px-4 py-2 text-center text-xs text-[color:var(--st-ink-50)]">
              Chat is unavailable on this page.
            </p>
          ) : null}

          {/* Input bar */}
          <div className="shrink-0 border-t border-[color:var(--st-line-10)] p-3">
            <div className="flex gap-2">
              <input
                type="text"
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendChatMessage(chatDraft);
                    setChatDraft("");
                  }
                }}
                placeholder="Type a message…"
                disabled={!shopId || chatSending}
                className="min-h-11 min-w-0 flex-1 rounded-[var(--st-r-md)] border border-[color:var(--st-line-15)] bg-[color:var(--st-field)] px-3 text-sm text-[color:var(--st-ink)] placeholder:text-[color:var(--st-ink-40)] outline-none focus:border-[color:var(--st-accent-50)] disabled:opacity-50"
                aria-label="Message"
              />
              <button
                type="button"
                onClick={() => {
                  void sendChatMessage(chatDraft);
                  setChatDraft("");
                }}
                disabled={!shopId || chatSending || !chatDraft.trim()}
                className="shrink-0 rounded-[var(--st-r-md)] bg-[color:var(--color-accent)] px-4 pp-heading text-sm font-semibold text-[color:var(--st-on-accent)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="pp-chat-fab flex h-14 w-14 cursor-pointer items-center justify-center rounded-full bg-[color:var(--color-accent)] text-[color:var(--st-on-accent)] shadow-xl transition hover:opacity-95 active:scale-95"
        aria-label={chatOpen ? "Close chat" : "Open chat"}
        aria-expanded={chatOpen}
        onClick={() => {
          if (chatOpen) {
            handleClose();
          } else {
            setChatOpen(true);
          }
        }}
      >
        <MessageCircle className="h-7 w-7" strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}
