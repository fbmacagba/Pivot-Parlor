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
          OPENAI_API_KEY: "test-openai-key",
          ANTHROPIC_API_KEY: "test-anthropic-key",
          // Webhook signature tests sign payloads with this and dispatch
          // through the real route (the sync-crypto regression hid behind
          // handler-only tests).
          STRIPE_WEBHOOK_SECRET: "whsec_test_signing_secret",
          STRIPE_SECRET_KEY: "sk_test_dummy_never_called",
        },
        serviceBindings: {
          // WS-1: stub of the pivot-parlor-booking binding. Echoes the request
          // so booking-proxy.test.ts can assert exactly what was forwarded;
          // the real contract is tested in apps/workers/booking's own suite
          // and end-to-end by the staging E2E booking spec.
          async BOOKING(req) {
            const body = req.method === "POST" ? await req.text() : null;
            return Response.json(
              {
                success: true,
                data: {
                  stub: "BOOKING",
                  url: req.url,
                  method: req.method,
                  body,
                  ip: req.headers.get("CF-Connecting-IP"),
                },
              },
              { status: req.method === "POST" ? 201 : 200 }
            );
          },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-schema.ts", "./test/setup-model-registry.ts"],
  },
});
