import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Every builder test runs inside workerd: the pure src/*.test.ts files run
// unchanged there, and test/*.test.ts drive the assembler against a real
// simulated D1 built from the main worker's full migration chain.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2025-06-01",
        // Needed by the test runner itself, not by the deployed worker.
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        bindings: { ENVIRONMENT: "test" },
        // The assembler makes no outbound requests; refuse any so one fails loudly.
        outboundService(request: Request): Response {
          return Response.json({ error: `blocked outbound ${new URL(request.url).hostname}` }, { status: 501 });
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/apply-schema.ts"],
    // apply-schema.ts replays the whole migration chain, one statement at a
    // time, before every test file. Under the pre-push gate (every workspace's
    // suite at once) that took over vitest's default 10 s, so whole files
    // failed before running a test. A replay that breaks still throws its own
    // error; this only says how long a slow one may take. Same as the API
    // and booking workers.
    hookTimeout: 60_000,
  },
});
