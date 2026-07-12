import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import tailwindStylesheet from "~/tailwind.css?url";
// Self-hosted fonts (WS-6 item 5 / LEG-5): the whole curated set registers its
// @font-face rules here — no Google Fonts requests anywhere in the app.
import "~/fonts";
import { PlatformCookieBanner } from "~/components/PlatformCookieBanner";
import { ErrorScreen } from "~/components/ErrorScreen";

export const links = () => [
  { rel: "stylesheet", href: tailwindStylesheet },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "icon", type: "image/x-icon", href: "/favicon.ico", sizes: "32x32" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
  { rel: "manifest", href: "/site.webmanifest" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head suppressHydrationWarning>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body
        className="bg-dark text-white font-sans antialiased"
        suppressHydrationWarning
      >
        {children}
        <ScrollRestoration />
        <Scripts />
        <PlatformCookieBanner />
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
