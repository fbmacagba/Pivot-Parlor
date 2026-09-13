import { defineConfig } from "vitest/config";

// Plain node vitest: the tested modules are pure (model resolution) or take an
// injected fetch (the LLM call); the Hono app itself is exercised on staging.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
