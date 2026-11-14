import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests for apps/web run in jsdom (DOM-dependent utilities such as the
// focus-trap). Route/loader integration is covered by the Playwright E2E
// suite, not here. tsconfigPaths mirrors vite.config.ts so tests can import
// via the `~/*` alias the same way route/component code does.
export default defineConfig({
  plugins: [tsconfigPaths()],
  // Until 2026-09 the root also held a second React (19.x, from the removed
  // docs app). Externalized deps like @radix-ui/* resolved that root copy at
  // require time, and two React instances in one render break isValidElement
  // (Radix Slot rejects the child as "not a valid React child"). React 18 is
  // the root copy now (app/lib/devServer.test.ts checks it); dedupe + inlining
  // stay so a second copy can never reach a test render again.
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.{ts,tsx}"],
    server: {
      deps: {
        inline: [/@radix-ui/],
      },
    },
  },
});
