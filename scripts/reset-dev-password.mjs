#!/usr/bin/env node
/**
 * Print SQL to seed-or-reset the developer account (dev@pivotparlor.com)
 * using the same PBKDF2 scheme as apps/worker/src/lib/password.ts (hashPassword).
 *
 * Emits an UPSERT: creates the account on a fresh database, resets the
 * password if it already exists. This is the ONLY supported way to provision
 * the developer account — the first-login bootstrap in /auth/login was
 * removed (account-takeover vector, June 2026 security review T1.1).
 *
 * Usage:
 *   1. Load DEV_PASSWORD (from env or .env):
 *        set -a && source .env && set +a   # bash
 *        # PowerShell: $env:DEV_PASSWORD = (Get-Content .env | ... )
 *   2. node scripts/reset-dev-password.mjs
 *   3. Apply against production D1 from apps/worker:
 *        cd apps/worker && npx wrangler d1 execute pivot-parlor-db --remote --command "<paste SQL>"
 *
 * Or pipe (bash): node scripts/reset-dev-password.mjs | tail -1 | xargs -I{} wrangler ...
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// v2 format from apps/worker/src/lib/password.ts (WS-7) — keep in sync.
const PBKDF2_ITERATIONS = 600_000;

async function hashPassword(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `v2:${PBKDF2_ITERATIONS}:${saltB64}:${hash}`;
}

const pwd = process.env.DEV_PASSWORD;
if (!pwd) {
  console.error("DEV_PASSWORD is not set. Set it in the environment or in .env at repo root.");
  process.exit(1);
}

const password_hash = await hashPassword(pwd);
const escaped = password_hash.replace(/'/g, "''");
// platform_users.email is UNIQUE (schema.sql), so the upsert keys on it.
const sql =
  `INSERT INTO platform_users (id, name, email, password_hash, role, shop_id, email_verified) ` +
  `VALUES (lower(hex(randomblob(16))), 'Developer', 'dev@pivotparlor.com', '${escaped}', 'developer', NULL, 1) ` +
  `ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash;`;

console.log("-- Copy the next line and run via wrangler d1 execute pivot-parlor-db --remote --command \"...\"");
console.log(sql);
