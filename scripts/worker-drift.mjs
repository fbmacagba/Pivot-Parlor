#!/usr/bin/env node
// Do the hand-deployed workers in production run main's code?
//
// Six background workers (every apps/workers folder except booking, which CI
// deploys) go to production by hand, so main can move on while production
// keeps an older build. For each one this builds main with
// `wrangler deploy --dry-run` (nothing is uploaded) and compares every module,
// source maps aside, with what Cloudflare runs. Exits 1 naming each worker
// that differs, so a merge that leaves one behind shows a red check.
//
// Needs CLOUDFLARE_API_TOKEN (Workers Scripts Read) and CLOUDFLARE_ACCOUNT_ID.
// Usage: node scripts/worker-drift.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { boundaryOf, compareBundles, deployedModules, handDeployedWorkers, multipartParts } from "./worker-drift-core.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const WORKERS_DIR = join(ROOT, "apps", "workers");
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("worker-drift: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  process.exit(2);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** { file: sha256 } for the modules a dry-run build of `dir` would upload. */
function localModules(dir) {
  const out = mkdtempSync(join(tmpdir(), `drift-${dir}-`));
  try {
    // The wrangler this worker resolves, run by node directly: no shell, so
    // nothing in a path is ever parsed as a command.
    const cwd = join(WORKERS_DIR, dir);
    const wranglerBin = join(dirname(createRequire(join(cwd, "package.json")).resolve("wrangler/package.json")), "bin", "wrangler.js");
    execFileSync(process.execPath, [wranglerBin, "deploy", "--dry-run", "--outdir", out], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const modules = {};
    for (const file of readdirSync(out)) {
      // wrangler also writes a README.md and the source maps; neither is code that runs.
      if (file.endsWith(".map") || file === "README.md" || !statSync(join(out, file)).isFile()) continue;
      modules[file] = sha256(readFileSync(join(out, file)));
    }
    return modules;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** { module: sha256 } for what Cloudflare runs as `script`. */
async function liveModules(script) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/content/v2`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`content/v2 for ${script}: HTTP ${res.status}`);
  const boundary = boundaryOf(res.headers.get("content-type"));
  if (!boundary) throw new Error(`content/v2 for ${script}: not multipart (${res.headers.get("content-type")})`);
  const parts = deployedModules(multipartParts(new Uint8Array(await res.arrayBuffer()), boundary));
  return Object.fromEntries(parts.map((p) => [p.name, sha256(p.body)]));
}

const folders = readdirSync(WORKERS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ dir: d.name, path: join(WORKERS_DIR, d.name, "wrangler.toml") }))
  .filter((d) => {
    try {
      return statSync(d.path).isFile();
    } catch {
      return false;
    }
  })
  .map((d) => ({ dir: d.dir, toml: readFileSync(d.path, "utf8") }));

let behind = 0;
let unchecked = 0;
for (const { dir, script } of handDeployedWorkers(folders)) {
  let local;
  let live;
  try {
    local = localModules(dir);
    live = await liveModules(script);
  } catch (err) {
    // A worker that cannot be compared is reported, never passed.
    unchecked += 1;
    console.log(`UNKNOWN ${script} (${dir}): could not compare: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    continue;
  }
  const r = compareBundles(local, live);
  if (r.match) {
    console.log(`OK      ${script} (${dir}): ${Object.keys(local).length} module(s) match main`);
    continue;
  }
  behind += 1;
  console.log(`BEHIND  ${script} (${dir}): production does not run main's build`);
  if (r.changed.length) console.log(`        changed: ${r.changed.join(", ")}`);
  if (r.missing.length) console.log(`        only in main's build: ${r.missing.join(", ")}`);
  if (r.extra.length) console.log(`        only in production: ${r.extra.join(", ")}`);
  console.log(`        deploy it by hand: cd apps/workers/${dir} && npx wrangler deploy`);
}
if (behind || unchecked) {
  console.error(`worker-drift: ${behind} hand-deployed worker(s) differ from main, ${unchecked} could not be compared`);
  process.exitCode = 1;
} else {
  console.log("worker-drift: every hand-deployed worker runs main's build");
}
