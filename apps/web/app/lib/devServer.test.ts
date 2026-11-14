// @vitest-environment node
/** The local dev server (`remix vite:dev`) renders pages.
 *
 *  CI deploys the production build and never starts the dev server, so on
 *  2026-11-14 `npm run dev` had been answering every page with 500 ("module is
 *  not defined") with nothing to say so. This starts the real dev server from
 *  vite.config.ts, the way `remix vite:dev` does, and GETs real pages.
 *
 *  Two things have to hold for it to pass:
 *  - `ssr.noExternal: true` applies to the build only. In dev, Remix's
 *    Cloudflare proxy plugin loads dependencies through Node with the
 *    `workerd` / `worker` conditions; inlining them instead makes Vite run
 *    React's CommonJS as ESM.
 *  - React is installed where the packages that use it can find it: hoisted
 *    to the root node_modules beside @remix-run/react and react-router-dom.
 *    The lockfile guard below checks that part directly. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { PORTFOLIO_DEMO_SLUG } from "@repo/utils";

// vitest runs from apps/web.
const WEB = process.cwd();
const ROOT = resolve(WEB, "../..");

let server: ViteDevServer | undefined;
let base = "";
const logged: string[] = [];

// The dev server runs in this process, so its loaders use this global fetch.
// Calls to the dev server itself and to loopback pass through; anything else
// (API_URL falls back to the production API when there is no .dev.vars) gets
// a canned API "not found" and is recorded, so the test never touches the
// network and can still see which API URL a loader called.
const realFetch = globalThis.fetch;
const apiCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (base && url.origin === new URL(base).origin) return realFetch(input, init);
  apiCalls.push(url.origin + url.pathname);
  if (loopback) return realFetch(input, init);
  return new Response(JSON.stringify({ success: false, error: "Not found (test stand-in)" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

beforeAll(async () => {
  server = await createServer({
    configFile: resolve(WEB, "vite.config.ts"),
    root: WEB,
    mode: "development",
    customLogger: {
      info: () => {},
      warn: (msg) => logged.push(msg),
      warnOnce: (msg) => logged.push(msg),
      error: (msg) => logged.push(msg),
      clearScreen: () => {},
      hasErrorLogged: () => false,
      hasWarned: false,
    },
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("dev server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await server?.close();
  globalThis.fetch = realFetch;
});

describe("local dev server", () => {
  it.each([
    ["/", "Pivot Parlor"],
    ["/pricing", "Pricing"],
    ["/login", "Sign in"],
  ])("GET %s renders the page", async (path, titleStart) => {
    const res = await fetch(base + path);
    const html = await res.text();
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null;
    expect(
      { status: res.status, title, errors: logged.filter((l) => /error|not defined|cannot find/i.test(l)) },
      `GET ${path}`
    ).toMatchObject({ status: 200, errors: [] });
    expect(title?.startsWith(titleStart), `title was ${title}`).toBe(true);
  }, 120_000);

  it("a shop loader gets production's load context: an unknown shop is a 404, after asking API_URL", async () => {
    // Production hands loaders { env, waitUntil, cspNonce } (functions/_middleware.ts).
    // Without the same shape in dev, `context.env.API_URL` throws and this is a 500.
    const res = await fetch(`${base}/no-such-page-xyz`);
    await res.text();
    expect(res.status).toBe(404);
    expect(apiCalls.some((u) => u.endsWith("/api/shops/no-such-page-xyz")), JSON.stringify(apiCalls)).toBe(true);
  }, 120_000);

  it("the portfolio demo shop renders from its bundled data when the API has no such shop", async () => {
    const res = await fetch(`${base}/${PORTFOLIO_DEMO_SLUG}`);
    const html = await res.text();
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? null;
    expect({ status: res.status, title }).toMatchObject({ status: 200 });
    expect(title, `title was ${title}`).toMatch(/FerdyM/);
  }, 120_000);

  it("no loader call left this machine", () => {
    const offMachine = apiCalls.filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(u));
    // Every off-machine call was answered by the stand-in above, never sent.
    expect(offMachine.every((u) => new URL(u).pathname.startsWith("/api/")), JSON.stringify(offMachine)).toBe(true);
  });
});

describe("React install layout", () => {
  it("React is hoisted to the root node_modules, where @remix-run/react and react-router-dom can find it", () => {
    const packages = (JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string }>;
    }).packages;
    const where = (name: string) =>
      Object.keys(packages).filter((p) => p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`));
    expect({ react: where("react"), "react-dom": where("react-dom") }).toEqual({
      react: ["node_modules/react"],
      "react-dom": ["node_modules/react-dom"],
    });
  });

  it("the lockfile has no workspace that no longer exists", () => {
    const packages = (JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, unknown>;
    }).packages;
    const missing = Object.keys(packages).filter((p) => {
      if (p === "" || p.includes("node_modules/")) return false;
      try {
        readFileSync(resolve(ROOT, p, "package.json"));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });
});
