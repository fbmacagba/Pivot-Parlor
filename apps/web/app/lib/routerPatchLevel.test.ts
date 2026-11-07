/** Lockfile guard: the React Router patch from the root `overrides` stays put.
 *
 *  @remix-run/react 2.17.5 pins react-router / react-router-dom 6.30.4 and
 *  @remix-run/router 1.23.3 exactly. The root package.json overrides them to
 *  the patched releases (GHSA-jjmj-jmhj-qwj2, fixed in 6.30.6). npm 11 does not
 *  apply those overrides when it rebuilds this workspace from an existing
 *  lockfile: on 2026-11-06 a plain `npm audit fix` silently re-nested 6.30.4 /
 *  1.23.3 under @remix-run/* and dropped the patched entries.
 *
 *  If this fails after `npm audit fix`, `npm update` or similar, restore the
 *  three hoisted entries at the override versions and delete the nested
 *  `node_modules/@remix-run/<pkg>/node_modules/...` copies, then `npm install`. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

type LockPackages = Record<string, { version?: string }>;

/** Every lockfile entry for an overridden package whose version differs from
 *  the override, as "path@version". Throws if an override has no entry at all,
 *  so the check can never pass vacuously. */
export function overrideViolations(
  packages: LockPackages,
  overrides: Record<string, string>
): string[] {
  const out: string[] = [];
  for (const [name, want] of Object.entries(overrides)) {
    const entries = Object.entries(packages).filter(
      ([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)
    );
    if (entries.length === 0) throw new Error(`no lockfile entry for ${name}`);
    for (const [path, meta] of entries) {
      if (meta.version !== want) out.push(`${path}@${meta.version}`);
    }
  }
  return out;
}

// vitest runs from apps/web (jsdom gives import.meta.url a non-file scheme).
const ROOT = resolve(process.cwd(), "../..");
const GUARDED = ["react-router", "react-router-dom", "@remix-run/router"];

function rootOverrides(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    overrides?: Record<string, string>;
  };
  return Object.fromEntries(GUARDED.map((name) => [name, pkg.overrides?.[name] ?? "(missing)"]));
}

describe("React Router patch level", () => {
  it("root package.json still overrides all three router packages", () => {
    expect(rootOverrides()).toEqual({
      "react-router": "6.30.6",
      "react-router-dom": "6.30.6",
      "@remix-run/router": "1.23.4",
    });
  });

  it("the lockfile holds only the overridden versions (no re-nested older copies)", () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
      packages: LockPackages;
    };
    expect(overrideViolations(lock.packages, rootOverrides())).toEqual([]);
  });

  it("the installed copies the Remix packages actually load are the overridden versions", () => {
    // Resolve each router package from where the importing Remix package lives,
    // exactly as the bundler and the server runtime do. This checks what
    // `npm ci` installed, not just what the lockfile says.
    const fromWeb = createRequire(resolve(process.cwd(), "package.json"));
    const want = rootOverrides();
    const loaded: Record<string, string> = {};
    for (const importer of ["@remix-run/react", "@remix-run/server-runtime", "@remix-run/dev"]) {
      const fromImporter = createRequire(fromWeb.resolve(`${importer}/package.json`));
      const deps = importer === "@remix-run/react" ? GUARDED : ["@remix-run/router"];
      for (const name of deps) {
        loaded[`${importer} -> ${name}`] = (fromImporter(`${name}/package.json`) as { version: string }).version;
      }
    }
    expect(loaded).toEqual({
      "@remix-run/react -> react-router": want["react-router"],
      "@remix-run/react -> react-router-dom": want["react-router-dom"],
      "@remix-run/react -> @remix-run/router": want["@remix-run/router"],
      "@remix-run/server-runtime -> @remix-run/router": want["@remix-run/router"],
      "@remix-run/dev -> @remix-run/router": want["@remix-run/router"],
    });
  });

  it("catches the shape `npm audit fix` produced on 2026-11-06", () => {
    const reverted: LockPackages = {
      "node_modules/@remix-run/react": { version: "2.17.5" },
      "node_modules/@remix-run/react/node_modules/react-router": { version: "6.30.4" },
      "node_modules/@remix-run/react/node_modules/react-router-dom": { version: "6.30.4" },
      "node_modules/@remix-run/react/node_modules/@remix-run/router": { version: "1.23.3" },
      "node_modules/@remix-run/dev/node_modules/@remix-run/router": { version: "1.23.3" },
    };
    expect(overrideViolations(reverted, rootOverrides())).toEqual([
      "node_modules/@remix-run/react/node_modules/react-router@6.30.4",
      "node_modules/@remix-run/react/node_modules/react-router-dom@6.30.4",
      "node_modules/@remix-run/react/node_modules/@remix-run/router@1.23.3",
      "node_modules/@remix-run/dev/node_modules/@remix-run/router@1.23.3",
    ]);
  });

  it("refuses to pass when a guarded package is missing from the lockfile", () => {
    expect(() => overrideViolations({}, { "react-router": "6.30.6" })).toThrow(/no lockfile entry/);
  });
});
