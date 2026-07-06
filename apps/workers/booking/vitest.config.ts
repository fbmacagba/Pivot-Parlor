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
        bindings: {
          JWT_SECRET: "test-secret",
          STRIPE_SECRET_KEY: "sk_test_dummy",
          ENVIRONMENT: "test",
          PLATFORM_URL: "https://platform.test",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-schema.ts"],
  },
});
