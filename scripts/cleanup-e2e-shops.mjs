#!/usr/bin/env node
/**
 * Delete `e2e-*` shops from a deployment. Two uses:
 *   1. CI / manual staging reset — clean slate before an E2E run (default target).
 *   2. One-off prod cleanup of junk left by E2E runs that targeted prod before the
 *      staging setup existed (requires the explicit `--allow-prod` flag).
 *
 * SAFETY:
 *   - Only ever deletes shops whose slug starts with `e2e-` (re-checked per call).
 *   - Refuses the production host unless `--allow-prod` is passed.
 *   - `--dry-run` lists targets without deleting; `--limit N` deletes only the
 *     first N (use `--limit 1` as a canary to confirm the FK cascade first).
 *
 * Auth: logs in as the dev account (DEV_PASSWORD) to get a developer JWT, then
 * calls the developer-only `POST /api/shops/:slug/delete` (DB cascade + KV cleanup).
 *
 *   API_BASE=https://pivot-parlor-api-staging.bmorris0565.workers.dev \
 *     node scripts/cleanup-e2e-shops.mjs --dry-run
 *   node scripts/cleanup-e2e-shops.mjs                 # staging (default)
 *   API_BASE=https://api.pivotparlor.com node scripts/cleanup-e2e-shops.mjs --allow-prod
 *
 * Env: API_BASE (default staging worker), DEV_EMAIL (default dev@pivotparlor.com),
 *      DEV_PASSWORD (required).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dotenv dependency) — only fills missing keys.
try {
  const env = readFileSync(join(__dirname, "..", ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch {
  /* no .env — rely on process env (e.g. CI) */
}

const STAGING_API = "https://pivot-parlor-api-staging.bmorris0565.workers.dev";
const API_BASE = (process.env.API_BASE ?? STAGING_API).replace(/\/$/, "");
const DEV_EMAIL = process.env.DEV_EMAIL ?? "dev@pivotparlor.com";
const DEV_PASSWORD = process.env.DEV_PASSWORD;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowProd = args.includes("--allow-prod");
const limitArg = args.indexOf("--limit");
const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;

const E2E_PREFIX = /^e2e-/;
const PROD_HOST = /(^|\.)pivotparlor\.com$/;

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  if (!DEV_PASSWORD) die("DEV_PASSWORD is not set (add it to .env or the environment).");

  const host = new URL(API_BASE).hostname;
  if (PROD_HOST.test(host) && !allowProd) {
    die(`API_BASE points at production (${host}). Refusing without --allow-prod.`);
  }

  console.log(`[cleanup] API: ${API_BASE}  mode: ${dryRun ? "DRY-RUN" : "DELETE"}${Number.isFinite(limit) ? `  limit: ${limit}` : ""}`);
  if (PROD_HOST.test(host)) console.log("[cleanup] ⚠ PRODUCTION target (--allow-prod set)");

  // 1. Login → developer JWT
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
  });
  const loginJson = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginJson?.data?.token) {
    die(`login failed: HTTP ${loginRes.status} ${JSON.stringify(loginJson).slice(0, 200)}`);
  }
  const token = loginJson.data.token;
  const role = loginJson.data.role;
  console.log(`[cleanup] logged in as ${DEV_EMAIL} (role: ${role})`);
  if (role !== "developer") die(`account role is "${role}", not "developer" — refusing to proceed.`);

  // 2. List all shops, filter to e2e-* only
  const listRes = await fetch(`${API_BASE}/api/shops`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listJson = await listRes.json().catch(() => ({}));
  if (!listRes.ok || !Array.isArray(listJson?.data)) {
    die(`shop list failed: HTTP ${listRes.status} ${JSON.stringify(listJson).slice(0, 200)}`);
  }
  const all = listJson.data;
  const targets = all.filter((s) => E2E_PREFIX.test(s.slug)).map((s) => s.slug);
  const keep = all.filter((s) => !E2E_PREFIX.test(s.slug)).map((s) => s.slug);

  console.log(`[cleanup] ${all.length} shops total — ${targets.length} e2e-* targets, ${keep.length} kept`);
  console.log(`[cleanup] KEEP: ${keep.join(", ") || "(none)"}`);

  const toDelete = targets.slice(0, limit);
  if (toDelete.length < targets.length) {
    console.log(`[cleanup] limited to first ${toDelete.length} of ${targets.length}`);
  }

  // 3. Delete each (guard: re-check prefix before every call)
  let ok = 0;
  const failures = [];
  for (const slug of toDelete) {
    if (!E2E_PREFIX.test(slug)) {
      failures.push({ slug, error: "refused: not an e2e- slug" });
      continue;
    }
    if (dryRun) {
      console.log(`  [dry-run] would delete ${slug}`);
      ok++;
      continue;
    }
    const res = await fetch(`${API_BASE}/api/shops/${encodeURIComponent(slug)}/delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body?.success) {
      console.log(`  ✓ deleted ${slug}`);
      ok++;
    } else {
      console.log(`  ✗ FAILED ${slug}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
      failures.push({ slug, status: res.status, error: body?.error });
    }
  }

  console.log(`\n[cleanup] done: ${ok} ${dryRun ? "would-delete" : "deleted"}, ${failures.length} failed`);
  if (failures.length) {
    console.log("[cleanup] failures:");
    for (const f of failures) console.log(`  - ${f.slug}: ${f.error ?? f.status}`);
    process.exit(1);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
