import { createRequire } from "module";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const require = createRequire(import.meta.url);

// @remix-run/dev ships CJS — use require() for both sub-paths
const { vitePlugin: remix } = require("@remix-run/dev/dist/vite") as {
  vitePlugin: (opts?: Record<string, unknown>) => import("vite").Plugin;
};

type DevPlatform = {
  cloudflare: {
    env: Record<string, unknown>;
    ctx: { waitUntil(promise: Promise<unknown>): void };
  };
};

// wrangler.toml's API_URL is the production API. In dev, with no .dev.vars
// override, that would sign people in, and change shops and bookings, on
// production from localhost. Dev uses the Worker dev server instead
// (`cd apps/worker && npm run dev`, port 8787). Any other API_URL, for example
// one set in apps/web/.dev.vars, is used as given.
const PRODUCTION_API = "https://api.pivotparlor.com";
const LOCAL_API = "http://localhost:8787";
let warnedLocalApi = false;
function devEnv(env: Record<string, unknown>): Record<string, unknown> {
  const apiUrl = typeof env.API_URL === "string" ? env.API_URL.replace(/\/+$/, "") : "";
  if (apiUrl !== PRODUCTION_API) return env;
  if (!warnedLocalApi) {
    warnedLocalApi = true;
    console.warn(
      `[dev] API_URL in wrangler.toml is the production API; dev uses ${LOCAL_API} ` +
        "(start it with: cd apps/worker && npm run dev). Set API_URL in apps/web/.dev.vars to use another API."
    );
  }
  return { ...env, API_URL: LOCAL_API };
}

const { cloudflareDevProxyVitePlugin } = require(
  "@remix-run/dev/dist/vite/cloudflare-proxy-plugin"
) as {
  cloudflareDevProxyVitePlugin: (options?: {
    getLoadContext?: (args: { request: Request; context: DevPlatform }) => unknown;
  }) => import("vite").Plugin;
};

export default defineConfig(({ command }) => ({
  plugins: [
    // Dev only. Loaders get the same load context as on Pages
    // (functions/_middleware.ts): `context.env`, `waitUntil`, and a CSP nonce,
    // which dev has none of. The plugin's default is `{ cloudflare }`, which
    // left every loader that reads `context.env.API_URL` throwing in dev.
    // `devEnv` keeps dev off the production API (above).
    cloudflareDevProxyVitePlugin({
      getLoadContext: ({ context }) => ({
        env: devEnv(context.cloudflare.env),
        waitUntil: (promise: Promise<unknown>) => context.cloudflare.ctx.waitUntil(promise),
        cspNonce: undefined,
      }),
    }),
    remix({
      future: {
        // Stay on classic data requests: turbo-stream 2.x has an upstream
        // single-fetch advisory. Reassess before enabling this feature.
        v3_singleFetch: false,
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
      },
    }),
    tsconfigPaths(),
  ],
  ssr: {
    target: "webworker",
    // Build only: the Pages bundle inlines every dependency. In dev, the
    // Cloudflare proxy plugin loads dependencies through Node with the
    // `workerd` / `worker` conditions; inlining them there makes Vite run
    // React's CommonJS as ESM and every page answers 500 ("module is not
    // defined"). app/lib/devServer.test.ts starts the dev server to prove it.
    noExternal: command === "build" ? true : undefined,
  },
}));
