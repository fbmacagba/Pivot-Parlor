import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { createApiClient } from "~/lib/api";

/**
 * Per-shop web app manifest (resource route: /:shopSlug/manifest.webmanifest).
 *
 * Installing from a shop's site must install THAT shop as the app - its name
 * on the home screen, opening at its page, scoped to its URLs - not the
 * Pivot Parlor platform app. PWA identity comes from the manifest's
 * id/start_url/scope, so each shop gets its own. root.tsx links this manifest
 * on shop routes and the platform /site.webmanifest everywhere else.
 *
 * Icons are the platform set for now; per-shop icons need PNG rasterization
 * of arbitrary logos (a job for the images worker) and can follow.
 */
export async function loader({ params, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const slug = params.shopSlug!;

  let shop: { slug: string; name: string; is_active?: number } | null = null;
  try {
    shop = await createApiClient(env.API_URL).get<{
      slug: string;
      name: string;
      is_active?: number;
    }>(`/api/shops/${encodeURIComponent(slug)}`);
  } catch {
    shop = null;
  }
  if (!shop?.slug || !shop.name) {
    throw new Response("Not found", { status: 404 });
  }

  const base = `/${shop.slug}`;
  const shortcutIcon = [{ src: "/icons/icon-192.png", sizes: "192x192" }];
  const manifest = {
    id: base,
    name: shop.name,
    // Home-screen labels truncate around 12 characters.
    short_name:
      shop.name.length > 12 ? `${shop.name.slice(0, 12).trimEnd()}` : shop.name,
    description: `Book appointments at ${shop.name}.`,
    start_url: base,
    scope: base,
    display: "standalone",
    background_color: "#0D0D0D",
    theme_color: "#0D0D0D",
    icons: [
      {
        src: "/favicon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Shortcut URLs must sit within scope, so these are shop pages (the
    // platform manifest's login/account/admin shortcuts would be rejected).
    shortcuts: [
      {
        name: "Book an appointment",
        url: `${base}/book`,
        icons: shortcutIcon,
      },
      {
        name: "Join the waitlist",
        url: `${base}/waitlist`,
        icons: shortcutIcon,
      },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json",
      // Shop renames propagate within the hour; installs are infrequent.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
