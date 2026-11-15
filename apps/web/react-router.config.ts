import type { Config } from "@react-router/dev/config";

export default {
  // Server-rendered on Cloudflare Pages (functions/_middleware.ts).
  ssr: true,
  // Every route's manifest ships with the page, as under Remix 2. Lazy route
  // discovery would add a /__manifest request per navigation, which the
  // middleware and the CSP have never seen.
  routeDiscovery: { mode: "initial" },
} satisfies Config;
