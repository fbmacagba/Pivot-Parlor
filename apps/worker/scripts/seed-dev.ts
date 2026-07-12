/**
 * seed-dev.ts — Seeds a developer account into Pivot Parlor's D1 database.
 *
 * Uses the IDENTICAL PBKDF2 algorithm from src/lib/password.ts so that the
 * login route's verifyPassword() will accept the seeded credentials.
 *
 * Usage (local D1 only):
 *   DEV_PASSWORD="your-secure-password" npm run seed:dev
 *
 * Usage (local + remote D1):
 *   DEV_REMOTE=true DEV_PASSWORD="your-secure-password" npm run seed:dev
 *
 * Optional overrides:
 *   DEV_EMAIL="dev@pivotparlor.com"   (default shown)
 *   DEV_NAME="Developer"              (default shown)
 */

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── PBKDF2 hash — mirrors hashPassword() in src/lib/password.ts exactly ─────
// Must match PBKDF2_ITERATIONS there: the Cloudflare Workers Web Crypto cap is
// 100_000, and seeded hashes have to verify under the worker runtime.

const PBKDF2_ITERATIONS = 100_000;

async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hash    = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `v2:${PBKDF2_ITERATIONS}:${saltB64}:${hash}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const DEV_EMAIL    = process.env.DEV_EMAIL    ?? "dev@pivotparlor.com";
  const DEV_NAME     = process.env.DEV_NAME     ?? "Developer";
  const DEV_PASSWORD = process.env.DEV_PASSWORD ?? "";
  const SEED_REMOTE  = process.env.DEV_REMOTE   === "true";

  if (!DEV_PASSWORD) {
    console.error("\n  ✖  DEV_PASSWORD is required.\n");
    console.error("     Usage:  DEV_PASSWORD=\"your-secure-password\" npm run seed:dev");
    console.error("     Remote: DEV_REMOTE=true DEV_PASSWORD=\"...\" npm run seed:dev\n");
    process.exit(1);
  }

  // Hash with PBKDF2 — same params as the worker's hashPassword()
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const id = crypto.randomUUID();

  // Base64 never contains single-quotes, but escape defensively anyway.
  const esc = (s: string) => s.replace(/'/g, "''");

  const sql =
    `-- Pivot Parlor developer seed (${new Date().toISOString()})\n` +
    `INSERT OR IGNORE INTO platform_users (id, name, email, password_hash, role, shop_id, email_verified)\n` +
    `VALUES (\n` +
    `  '${esc(id)}',\n` +
    `  '${esc(DEV_NAME)}',\n` +
    `  '${esc(DEV_EMAIL)}',\n` +
    `  '${esc(passwordHash)}',\n` +
    `  'developer',\n` +
    `  NULL,\n` +
    `  1\n` +
    `);\n`;

  console.log("\n  Pivot Parlor — developer account seed");
  console.log("  ──────────────────────────────────────");
  console.log(`  Email : ${DEV_EMAIL}`);
  console.log(`  Name  : ${DEV_NAME}`);
  console.log(`  Role  : developer`);
  console.log(`  Hash  : ${passwordHash.slice(0, 24)}…  (PBKDF2/SHA-256, ${PBKDF2_ITERATIONS.toLocaleString()} iterations)\n`);

  // Resolve the worker root so wrangler can find wrangler.toml
  const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  // Local: use --file (avoids shell-escaping the whole SQL string)
  // Remote: use --command (the file-import API returns 10000 auth errors with
  //   the D1 write scope; --command uses the query API which works fine)
  const tmpFile = join(tmpdir(), `pp-seed-${Date.now()}.sql`);

  function runLocal() {
    writeFileSync(tmpFile, sql, "utf8");
    try {
      execSync(
        `npx wrangler d1 execute pivot-parlor-db --file="${tmpFile}"`,
        { stdio: "inherit", cwd: workerRoot }
      );
    } finally {
      try { unlinkSync(tmpFile); } catch { /* already gone */ }
    }
  }

  function runRemote() {
    // Build a single-line SQL string (strip comment lines so `--` is never the
    // first token, which wrangler would parse as a CLI flag).
    const commandSql = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--") && l.trim() !== "")
      .join(" ")
      .trim();

    // Invoke wrangler via `node node_modules/wrangler/bin/wrangler.js` with
    // shell:false so Node passes the args array directly to the child process —
    // no shell expansion, no splitting on spaces inside the SQL value.
    const wranglerBin = join(workerRoot, "node_modules", "wrangler", "bin", "wrangler.js");
    const result = spawnSync(
      process.execPath,   // the current node binary
      [wranglerBin, "d1", "execute", "pivot-parlor-db", "--remote", "--command", commandSql],
      { stdio: "inherit", cwd: workerRoot, shell: false }
    );
    if (result.status !== 0) {
      throw new Error(`wrangler exited with status ${result.status ?? "unknown"}`);
    }
  }

  console.log("  → Seeding local D1…\n");
  runLocal();

  if (SEED_REMOTE) {
    console.log("\n  → Seeding remote D1…\n");
    runRemote();
  } else {
    console.log(
      "\n  ℹ  Skipped remote D1." +
      " Run with DEV_REMOTE=true to also seed production.\n"
    );
  }

  console.log("  ✔  Done.\n");
}

main().catch((err) => {
  console.error("\n  ✖  Seed failed:", err);
  process.exit(1);
});
