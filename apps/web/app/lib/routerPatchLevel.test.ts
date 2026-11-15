/** Lockfile guard: the website runs on a React Router release with its
 *  advisories fixed, and nothing of Remix 2 is left to load.
 *
 *  - react-router 7.18.0 fixes GHSA-wrjc and GHSA-337j; 7.14.0 fixed rxv8 in
 *    its single-fetch stream encoder. Every copy must be 7.18.0 or later.
 *  - turbo-stream 2.x carries rxv8. React Router 7 vendors its own encoder, so
 *    no copy below 3.0.0 may come back through another package.
 *  - react-router-dom and every @remix-run/* package are gone. The one
 *    exception is @remix-run/node-fetch-server, which @react-router/dev
 *    brings for its dev server and which never ships in the website.
 *  - The root overrides that pinned react-router 6.30.6 under Remix 2 are
 *    gone: kept, they would hold the website on 6.x.
 *  - @react-router/cloudflare (the Pages adapter) loads the root react-router,
 *    so the adapter and the app share one router.
 *
 *  If this fails after `npm install`, `npm audit fix` or `npm update`, see
 *  docs/superpowers/plans/2026-11-14-react-router-7.md (Step 0 ruling 1): a
 *  nested react-router under apps/web is fixed by dropping that lockfile
 *  entry, deleting the directory and running `npm install` again. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

type LockPackages = Record<string, { version?: string }>;

/** True when `version` ("x.y.z", any pre-release tag ignored) is at least `floor`. */
function atLeast(version: string, floor: string): boolean {
  const parse = (v: string) => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** The lockfile paths that install a package called `name`, at any depth. */
export function nodesNamed(packages: LockPackages, name: string): string[] {
  return Object.keys(packages).filter((p) => p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`));
}

/** Every copy of `name` below `floor`, as "path@version". With `required`, a
 *  lockfile holding no copy at all throws, so the check cannot pass vacuously. */
export function copiesBelow(packages: LockPackages, name: string, floor: string, required = false): string[] {
  const nodes = nodesNamed(packages, name);
  if (required && nodes.length === 0) throw new Error(`no lockfile entry for ${name}`);
  return nodes
    .map((p) => `${p}@${packages[p].version ?? "(none)"}`)
    .filter((entry) => !atLeast(entry.slice(entry.lastIndexOf("@") + 1), floor));
}

const ALLOWED_REMIX = new Set(["@remix-run/node-fetch-server"]);

/** Every lockfile path that installs an @remix-run/* package other than the allowed one. */
export function remixLeftovers(packages: LockPackages): string[] {
  return Object.keys(packages).filter((p) => {
    const at = p.lastIndexOf("node_modules/@remix-run/");
    if (at === -1) return false;
    const name = p.slice(at + "node_modules/".length).split("/").slice(0, 2).join("/");
    return !ALLOWED_REMIX.has(name);
  });
}

const RETIRED_OVERRIDES = ["react-router", "react-router-dom", "@remix-run/router"];

// vitest runs from apps/web (jsdom gives import.meta.url a non-file scheme).
const ROOT = resolve(process.cwd(), "../..");
const lock = () =>
  (JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as { packages: LockPackages }).packages;
const rootOverrides = () =>
  (JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { overrides?: Record<string, unknown> })
    .overrides ?? {};

describe("React Router patch level", () => {
  it("every react-router in the lockfile is 7.18.0 or later, and there is one", () => {
    expect(copiesBelow(lock(), "react-router", "7.18.0", true)).toEqual([]);
  });

  it("no turbo-stream in the lockfile is below 3.0.0", () => {
    expect(copiesBelow(lock(), "turbo-stream", "3.0.0")).toEqual([]);
  });

  it("react-router-dom is gone", () => {
    expect(nodesNamed(lock(), "react-router-dom")).toEqual([]);
  });

  it("no Remix package is left but the dev server's node-fetch-server", () => {
    expect(remixLeftovers(lock())).toEqual([]);
  });

  it("the root package.json no longer overrides the router packages", () => {
    expect(RETIRED_OVERRIDES.filter((name) => name in rootOverrides())).toEqual([]);
  });

  it("the Pages adapter loads the root react-router, the one the app uses", () => {
    const fromWeb = createRequire(resolve(process.cwd(), "package.json"));
    const fromAdapter = createRequire(fromWeb.resolve("@react-router/cloudflare"));
    const loaded = fromAdapter.resolve("react-router");
    const rootCopy = resolve(ROOT, "node_modules/react-router");
    expect(resolve(loaded).startsWith(rootCopy), `${loaded} is not under ${rootCopy}`).toBe(true);
    expect(resolve(dirname(fromWeb.resolve("react-router"))).startsWith(rootCopy)).toBe(true);
  });

  it("catches the Remix 2 lockfile shape", () => {
    const remix2: LockPackages = {
      "node_modules/react-router": { version: "6.30.6" },
      "node_modules/react-router-dom": { version: "6.30.6" },
      "node_modules/@remix-run/react": { version: "2.17.5" },
      "node_modules/@remix-run/router": { version: "1.23.4" },
      "node_modules/@remix-run/dev/node_modules/@remix-run/router": { version: "1.23.4" },
      "node_modules/@remix-run/node-fetch-server": { version: "0.9.0" },
      "node_modules/turbo-stream": { version: "2.4.1" },
    };
    expect(copiesBelow(remix2, "react-router", "7.18.0", true)).toEqual(["node_modules/react-router@6.30.6"]);
    expect(copiesBelow(remix2, "turbo-stream", "3.0.0")).toEqual(["node_modules/turbo-stream@2.4.1"]);
    expect(nodesNamed(remix2, "react-router-dom")).toEqual(["node_modules/react-router-dom"]);
    expect(remixLeftovers(remix2)).toEqual([
      "node_modules/@remix-run/react",
      "node_modules/@remix-run/router",
      "node_modules/@remix-run/dev/node_modules/@remix-run/router",
    ]);
  });

  it("catches an older react-router nested under another package", () => {
    const nested: LockPackages = {
      "node_modules/react-router": { version: "7.18.5" },
      "apps/web/node_modules/react-router": { version: "7.14.0" },
    };
    expect(copiesBelow(nested, "react-router", "7.18.0", true)).toEqual(["apps/web/node_modules/react-router@7.14.0"]);
  });

  it("refuses to pass when react-router is missing from the lockfile", () => {
    expect(() => copiesBelow({}, "react-router", "7.18.0", true)).toThrow(/no lockfile entry/);
  });
});
