import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Unit tests for apps/web run in jsdom (DOM-dependent utilities such as the
// focus-trap). Route/loader integration is covered by the Playwright E2E
// suite, not here. tsconfigPaths mirrors vite.config.ts so tests can import
// via the `~/*` alias the same way route/component code does.
export default defineConfig({
  plugins: [tsconfigPaths()],
  // The monorepo root hoists a second React (19.x, pulled in by tooling)
  // alongside this app's React 18. Externalized deps like @radix-ui/*
  // would resolve that root copy at require time, and two React instances
  // in one render break isValidElement (Radix Slot rejects the child as
  // "not a valid React child"). Dedupe + inlining keeps every import on
  // this app's React — matching how Vite resolves the production build.
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
