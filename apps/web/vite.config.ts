import { reactRouter } from "@react-router/dev/vite";
import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { webLoadContext } from "./app/lib/loadContext";

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

export default defineConfig(({ command }) => ({
  plugins: [
    // Dev only, and it must come before reactRouter(). Loaders get the same
    // load context as on Pages (functions/_middleware.ts): `context.env`,
    // `waitUntil`, and a CSP nonce, which dev has none of. `devEnv` keeps dev
    // off the production API (above).
    // The plugin cannot infer the bindings' type; they are read as plain values.
    cloudflareDevProxy<Record<string, unknown>, Record<string, unknown>>({
      getLoadContext: ({ context }) => webLoadContext({ ...context.cloudflare, env: devEnv(context.cloudflare.env) }),
    }),
    // Single fetch is always on. Its stream advisory (rxv8, turbo-stream 2.x) is
    // fixed in react-router 7.14.0 and later; app/lib/routerPatchLevel.test.ts
    // holds the floor.
    reactRouter(),
    tsconfigPaths(),
  ],
  ssr: {
    target: "webworker",
    // Build only: the Pages bundle inlines every dependency. In dev, the
    // Cloudflare dev proxy loads dependencies through Node with the
    // `workerd` / `worker` conditions; inlining them there makes Vite run
    // React's CommonJS as ESM and every page answers 500 ("module is not
    // defined"). app/lib/devServer.test.ts starts the dev server to prove it.
    noExternal: command === "build" ? true : undefined,
  },
}));
