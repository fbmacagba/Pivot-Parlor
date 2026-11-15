// @vitest-environment node
/** The production server bundle resolves its dependencies for a worker, not for Node.
 *
 *  Pages runs build/server in workerd. With `ssr.target: "webworker"`, Vite's own
 *  default conditions are the browser ones (`module`, `browser`, `production`),
 *  and the Remix 2 build used exactly those. `@react-router/dev` sets Node's
 *  server conditions instead, so `react-dom/server` resolved to React's Node
 *  renderer, which has no `renderToReadableStream`, and on 2026-11-14 every page
 *  of the built site answered 500 while the build and every test passed.
 *
 *  vite.config.ts puts Vite's webworker defaults back for the server build.
 *  scripts/smoke-build.mjs (run in CI after the build) checks the built site
 *  under workerd; this checks the configuration in seconds. */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { defaultClientConditions, defaultClientMainFields, resolveConfig } from "vite";

// vitest runs from apps/web.
const WEB = process.cwd();

describe("server build resolution", () => {
  it("resolves dependencies for workerd first, then with Vite's webworker conditions: no `node`", async () => {
    const config = await resolveConfig(
      { configFile: resolve(WEB, "vite.config.ts"), root: WEB, mode: "production", logLevel: "silent", build: { ssr: true } },
      "build",
      "production",
      "production"
    );
    const { conditions, mainFields } = config.environments.ssr.resolve;
    expect(conditions).not.toContain("node");
    // React 19's react-dom/server: "workerd" is its edge build. Its "browser"
    // build needs MessageChannel when it loads, which workerd does not have at
    // this compatibility date, so the worker fails to start.
    expect(conditions).toEqual(["workerd", ...defaultClientConditions]);
    expect(mainFields).toEqual(defaultClientMainFields);
  }, 120_000);
});
