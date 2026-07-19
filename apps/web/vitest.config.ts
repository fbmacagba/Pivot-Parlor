import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests for apps/web run in jsdom (DOM-dependent utilities such as the
// focus-trap). Route/loader integration is covered by the Playwright E2E
// suite, not here. tsconfigPaths mirrors vite.config.ts so tests can import
// via the `~/*` alias the same way route/component code does.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
