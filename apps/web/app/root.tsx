import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import tailwindStylesheet from "~/tailwind.css?url";
import { PlatformCookieBanner } from "~/components/PlatformCookieBanner";
import { ErrorScreen } from "~/components/ErrorScreen";

export const links = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous" as const,
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap",
  },
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
