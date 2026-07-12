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
          STRIPE_WEBHOOK_SECRET: "whsec_test",
          ENVIRONMENT: "test",
          PLATFORM_URL: "https://platform.test",
        },
        // Fake Stripe for outbound fetch. PaymentIntent creation echoes the
        // received Idempotency-Key into the returned id (pi_idem_<key>) so
        // tests can assert the key from the persisted DB rows; a PI id
        // containing "fail" makes capture 500 to exercise failure paths.
        outboundService(request: Request): Response | Promise<Response> {
          const url = new URL(request.url);
          if (url.hostname !== "api.stripe.com") {
            return Response.json({ error: { message: `blocked outbound ${url.hostname}` } }, { status: 501 });
          }
          const idem = request.headers.get("Idempotency-Key") ?? "";
          const path = url.pathname;
          if (path === "/v1/payment_intents" && request.method === "POST") {
            return Response.json({ id: `pi_idem_${idem}`, client_secret: "cs_test", latest_charge: "ch_test" });
          }
          const capture = path.match(/^\/v1\/payment_intents\/([^/]+)\/capture$/);
          if (capture) {
            const piId = decodeURIComponent(capture[1]!);
            if (piId.includes("fail")) {
              return Response.json({ error: { message: "stripe down" } }, { status: 500 });
            }
            return Response.json({ id: piId, status: "succeeded", latest_charge: "ch_cap_1" });
          }
          const cancel = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/);
          if (cancel) {
            return Response.json({ id: decodeURIComponent(cancel[1]!), status: "canceled" });
          }
          if (path === "/v1/accounts" && request.method === "POST") {
            return Response.json({ id: "acct_new_1" });
          }
          const acct = path.match(/^\/v1\/accounts\/([^/]+)$/);
          if (acct) {
            return Response.json({
              id: decodeURIComponent(acct[1]!),
              charges_enabled: true,
              details_submitted: true,
              payouts_enabled: true,
            });
          }
          if (path === "/v1/account_links" && request.method === "POST") {
            return Response.json({ url: "https://connect.stripe.com/setup/e/test" });
          }
          if (path === "/v1/refunds" && request.method === "POST") {
            // Same echo trick: the Idempotency-Key (refund:<returnId>) lands in
            // the refund id so tests assert it from persisted rows. A
            // payment_intent containing "fail" simulates a Stripe outage.
            return request.text().then((form) => {
              if (form.includes("fail")) {
                return Response.json({ error: { message: "stripe down" } }, { status: 500 });
              }
              return Response.json({ id: `re_idem_${idem}`, status: "pending" });
            });
          }
          if (path === "/v1/checkout/sessions" && request.method === "POST") {
            // Same echo trick as payment_intents: the Idempotency-Key lands in
            // the session id so tests assert it from persisted rows.
            return Response.json({
              id: `cs_idem_${idem}`,
              url: `https://checkout.stripe.com/c/pay/cs_idem_${idem}`,
            });
          }
          return Response.json({ error: { message: `unmocked stripe path ${path}` } }, { status: 500 });
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-schema.ts"],
  },
});
