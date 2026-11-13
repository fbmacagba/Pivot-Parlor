import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import tailwindStylesheet from "~/tailwind.css?url";
// Self-hosted fonts (WS-6 item 5 / LEG-5): the whole curated set registers its
// @font-face rules here — no Google Fonts requests anywhere in the app.
import "~/fonts";
import { PlatformCookieBanner } from "~/components/PlatformCookieBanner";
import { InstallAppPrompt } from "~/components/InstallAppPrompt";
import { ErrorScreen } from "~/components/ErrorScreen";
import { useShopMatch } from "~/lib/shop-match";
import { useCspNonce } from "~/lib/cspNonce";

export const links = () => [
  { rel: "stylesheet", href: tailwindStylesheet },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "icon", type: "image/x-icon", href: "/favicon.ico", sizes: "32x32" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
  // The manifest link is rendered in Layout, not here: shop routes must link
  // their own per-shop manifest so installs capture the SHOP as the app.
];

export function Layout({ children }: { children: React.ReactNode }) {
  // On /:shopSlug routes the installed app is the shop, not the platform.
  const shopMatch = useShopMatch();
  // Inline scripts run only with the response's nonce (app/lib/securityHeaders.ts).
  const nonce = useCspNonce();
  return (
    <html lang="en" suppressHydrationWarning>
      <head suppressHydrationWarning>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover lets the app paint edge to edge on notched
            devices when installed; safe-area padding in tailwind.css keeps
            content clear of the home indicator. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#0D0D0D" />
        {/* Installed-app chrome: standalone full screen with a black status
            bar on iOS, matching the dark theme. */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black" />
        <meta
          name="apple-mobile-web-app-title"
          content={shopMatch?.name ?? "Pivot Parlor"}
        />
        <link
          rel="manifest"
          href={
            shopMatch
              ? `/${shopMatch.slug}/manifest.webmanifest`
              : "/site.webmanifest"
          }
        />
        <Meta />
        <Links />
      </head>
      <body
        className="bg-dark text-white font-sans antialiased"
        suppressHydrationWarning
      >
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
        <PlatformCookieBanner />
        <InstallAppPrompt />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Top-level fallback: renders inside <Layout> for any error not caught by a
// nested route boundary (loader/action throws, render error, unmatched route).
export function ErrorBoundary() {
  return <ErrorScreen fullscreen />;
}
