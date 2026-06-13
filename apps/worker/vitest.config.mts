import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        r2Buckets: ["ASSETS"],
        bindings: {
          JWT_SECRET: "test-secret",
          OPENROUTER_API_KEY: "test-openrouter-key",
          GOOGLE_AI_API_KEY: "test-google-key",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-schema.ts"],
  },
});
