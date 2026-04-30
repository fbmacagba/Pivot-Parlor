import { createRequire } from "module";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
const require = createRequire(import.meta.url);
// @remix-run/dev ships CJS — use require() for both sub-paths
const { vitePlugin: remix } = require("@remix-run/dev/dist/vite");
const { cloudflareDevProxyVitePlugin } = require("@remix-run/dev/dist/vite/cloudflare-proxy-plugin");
export default defineConfig({
    plugins: [
        cloudflareDevProxyVitePlugin(),
        remix({
            future: {
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
