#!/usr/bin/env node
/**
 * One-time: print SQL to set platform_users.password_hash for dev@pivotparlor.com
 * using the same PBKDF2 scheme as apps/worker/src/routes/auth.ts (hashPassword).
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

async function hashPassword(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  const saltB64 = btoa(String.fromCharCode(...salt));
  return `${saltB64}:${hash}`;
}

const pwd = process.env.DEV_PASSWORD;
if (!pwd) {
  console.error("DEV_PASSWORD is not set. Set it in the environment or in .env at repo root.");
  process.exit(1);
}

const password_hash = await hashPassword(pwd);
const escaped = password_hash.replace(/'/g, "''");
const sql = `UPDATE platform_users SET password_hash = '${escaped}' WHERE email = 'dev@pivotparlor.com';`;

console.log("-- Copy the next line and run via wrangler d1 execute pivot-parlor-db --remote --command \"...\"");
console.log(sql);
