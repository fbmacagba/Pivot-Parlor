import { defineConfig } from "vitest/config";

// Unit tests for apps/web run in jsdom (DOM-dependent utilities such as the
// focus-trap). Route/loader integration is covered by the Playwright E2E
// suite, not here.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["app/**/*.test.{ts,tsx}"],
  },
});
