/** Lockfile guard: the dev-tool security fixes stay put.
 *
 *  - Vite: apps/web is on Vite 6.4.4 or later. Every Vite 5 release and 6.x up
 *    to 6.4.3 has dev-server advisories (path traversal and file reads,
 *    GHSA-4w7w-66w2-5vf9 and siblings). @remix-run/dev 2.17.5 accepts
 *    `vite: ^5.1.0 || ^6.0.0`.
 *  - undici: miniflare, which runs every worker test suite, gets undici
 *    7.30.1 or later through the root `overrides` (`miniflare > undici`).
 *    @cloudflare/vitest-pool-workers 0.16.20 pins miniflare 4.20260625.0
 *    exactly, and that pins undici 7.28.0 exactly (GHSA-4cwx-7wf7-3272 and 22
 *    more, fixed by 7.30.1).
 *
 *  npm 11 can drop a root override when it rebuilds this workspace from an
 *  existing lockfile (see routerPatchLevel.test.ts). If this fails after
 *  `npm audit fix`, `npm update` or similar, re-run `npm install` and check the
 *  copies named in the failure. */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type LockPackages = Record<string, { version?: string; link?: boolean; resolved?: string }>;

/** True when `version` ("x.y.z", any pre-release tag ignored) is at least `floor`. */
export function atLeast(version: string, floor: string): boolean {
  const parse = (v: string) => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** The lockfile path Node would load `name` from when required by the package
 *  at `fromPath`: its own node_modules first, then each enclosing node_modules
 *  up to the root. Returns null when nothing on that chain provides it. */
export function resolveInLock(packages: LockPackages, fromPath: string, name: string): string | null {
  let base = fromPath;
  for (;;) {
    const candidate = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (base === "") return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut === -1 ? "" : base.slice(0, cut);
  }
}

/** For every lockfile copy of `importer`, the `dep` it loads, as
 *  "importerPath -> depPath@version" when that version is below `floor`.
 *  Throws when there is no copy of `importer`, or a copy cannot resolve `dep`,
 *  so the check can never pass vacuously. */
export function belowFloor(packages: LockPackages, importer: string, dep: string, floor: string): string[] {
  const importers = Object.keys(packages).filter(
    (path) => path === `node_modules/${importer}` || path.endsWith(`/node_modules/${importer}`)
  );
  if (importers.length === 0) throw new Error(`no lockfile entry for ${importer}`);
  const out: string[] = [];
  for (const from of importers) {
    const at = resolveInLock(packages, from, dep);
    if (!at) throw new Error(`${from} resolves no ${dep}`);
    const version = packages[at].version ?? "(none)";
    if (!atLeast(version, floor)) out.push(`${from} -> ${at}@${version}`);
  }
  return out;
}

// vitest runs from apps/web (jsdom gives import.meta.url a non-file scheme).
const ROOT = resolve(process.cwd(), "../..");
const VITE_FLOOR = "6.4.4";
const UNDICI_FLOOR = "7.30.1";

function lockPackages(): LockPackages {
  return (JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as { packages: LockPackages }).packages;
}

/** The version of `name` that Node loads from `fromDir`, found on disk the way
 *  Node resolves it: `fromDir/node_modules/name`, then each enclosing directory
 *  up to `root`. Reads package.json directly, because some packages (miniflare's
 *  importer among them) do not export it. Null when nothing provides it. */
export function installedVersion(fromDir: string, name: string, root: string): string | null {
  let dir = fromDir;
  for (;;) {
    const manifest = join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
    if (resolve(dir) === resolve(root)) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Every installed copy of `importer` (at the paths the lockfile names) whose
 *  on-disk `dep` is below `floor`, as "dir -> dep@version". */
export function installedBelowFloor(
  packages: LockPackages,
  root: string,
  importer: string,
  dep: string,
  floor: string
): string[] {
  const out: string[] = [];
  const importers = Object.keys(packages).filter(
    (path) => path === `node_modules/${importer}` || path.endsWith(`/node_modules/${importer}`)
  );
  if (importers.length === 0) throw new Error(`no lockfile entry for ${importer}`);
  for (const path of importers) {
    const dir = join(root, path);
    if (!existsSync(join(dir, "package.json"))) throw new Error(`${path} is in the lockfile but not installed`);
    const version = installedVersion(dir, dep, root);
    if (version === null) throw new Error(`${path} loads no ${dep} on disk`);
    if (!atLeast(version, floor)) out.push(`${path} -> ${dep}@${version}`);
  }
  return out;
}

describe("dev-tool patch levels", () => {
  it("the Vite apps/web builds with is 6.4.4 or later, in the lockfile", () => {
    const packages = lockPackages();
    const at = resolveInLock(packages, "apps/web", "vite");
    expect(at).not.toBeNull();
    const version = packages[at as string].version ?? "(none)";
    expect(atLeast(version, VITE_FLOOR), `${at}@${version}`).toBe(true);
  });

  it("the Vite @remix-run/dev loads is 6.4.4 or later, in the lockfile", () => {
    expect(belowFloor(lockPackages(), "@remix-run/dev", "vite", VITE_FLOOR)).toEqual([]);
  });

  it("every miniflare in the lockfile loads undici 7.30.1 or later", () => {
    expect(belowFloor(lockPackages(), "miniflare", "undici", UNDICI_FLOOR)).toEqual([]);
  });

  it("the installed copies are the patched versions too (what npm ci put on disk)", () => {
    const packages = lockPackages();
    const vite = installedVersion(join(ROOT, "apps/web"), "vite", ROOT);
    expect(vite !== null && atLeast(vite, VITE_FLOOR), `apps/web loads vite@${vite}`).toBe(true);
    expect(installedBelowFloor(packages, ROOT, "@remix-run/dev", "vite", VITE_FLOOR)).toEqual([]);
    expect(installedBelowFloor(packages, ROOT, "miniflare", "undici", UNDICI_FLOOR)).toEqual([]);
  });

  it("the on-disk check catches an old undici installed under miniflare", () => {
    const root = mkdtempSync(join(tmpdir(), "devtool-guard-"));
    try {
      const write = (rel: string, version: string) => {
        mkdirSync(join(root, rel), { recursive: true });
        writeFileSync(join(root, rel, "package.json"), JSON.stringify({ version }));
      };
      write("node_modules/miniflare", "4.20260625.0");
      write("node_modules/miniflare/node_modules/undici", "7.28.0");
      write("node_modules/wrangler/node_modules/miniflare", "5.20261023.1-beta");
      write("node_modules/wrangler/node_modules/undici", "7.30.2");
      const lock: LockPackages = {
        "node_modules/miniflare": {},
        "node_modules/wrangler/node_modules/miniflare": {},
      };
      expect(installedBelowFloor(lock, root, "miniflare", "undici", UNDICI_FLOOR)).toEqual([
        "node_modules/miniflare -> undici@7.28.0",
      ]);
      expect(() => installedBelowFloor({ "node_modules/absent": {} }, root, "absent", "undici", UNDICI_FLOOR))
        .toThrow(/not installed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("catches the shape the tree had before the fix", () => {
    const before: LockPackages = {
      "apps/web": {},
      "node_modules/vite": { version: "5.4.21" },
      "node_modules/@remix-run/dev": { version: "2.17.5" },
      "node_modules/miniflare": { version: "4.20260625.0" },
      "node_modules/miniflare/node_modules/undici": { version: "7.28.0" },
      "node_modules/wrangler/node_modules/miniflare": { version: "5.20261023.1-beta" },
      "node_modules/wrangler/node_modules/undici": { version: "7.30.1" },
    };
    expect(resolveInLock(before, "apps/web", "vite")).toBe("node_modules/vite");
    expect(belowFloor(before, "@remix-run/dev", "vite", VITE_FLOOR)).toEqual([
      "node_modules/@remix-run/dev -> node_modules/vite@5.4.21",
    ]);
    expect(belowFloor(before, "miniflare", "undici", UNDICI_FLOOR)).toEqual([
      "node_modules/miniflare -> node_modules/miniflare/node_modules/undici@7.28.0",
    ]);
  });

  it("refuses to pass vacuously", () => {
    expect(() => belowFloor({}, "miniflare", "undici", UNDICI_FLOOR)).toThrow(/no lockfile entry/);
    expect(() => belowFloor({ "node_modules/miniflare": { version: "4.0.0" } }, "miniflare", "undici", UNDICI_FLOOR))
      .toThrow(/resolves no undici/);
  });

  it("compares versions numerically, not as text", () => {
    expect(atLeast("6.4.10", "6.4.4")).toBe(true);
    expect(atLeast("6.4.3", "6.4.4")).toBe(false);
    expect(atLeast("7.30.1", "7.30.1")).toBe(true);
    expect(atLeast("7.9.0", "7.30.1")).toBe(false);
    expect(atLeast("5.20261023.1-beta", "4.0.0")).toBe(true);
  });
});
