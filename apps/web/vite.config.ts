import { createRequire } from "module";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const require = createRequire(import.meta.url);

// @remix-run/dev ships CJS — use require() for both sub-paths
const { vitePlugin: remix } = require("@remix-run/dev/dist/vite") as {
  vitePlugin: (opts?: Record<string, unknown>) => import("vite").Plugin;
};

const { cloudflareDevProxyVitePlugin } = require(
  "@remix-run/dev/dist/vite/cloudflare-proxy-plugin"
) as {
  cloudflareDevProxyVitePlugin: () => import("vite").Plugin;
};

export default defineConfig({
  plugins: [
    cloudflareDevProxyVitePlugin(),
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
    noExternal: true,
  },
});
