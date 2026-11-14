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
    cloudflareDevProxyVitePlugin({
      getLoadContext: ({ context }) => ({
        env: context.cloudflare.env,
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
