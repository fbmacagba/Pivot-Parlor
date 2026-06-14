#!/usr/bin/env node
/**
 * Remove compiled .js / .js.map twins from app/.
 *
 * Remix route discovery prefers .js over .tsx, so a stale compiled twin
 * silently shadows its edited .tsx source and breaks `vite:build` with
 * route ID collisions. App source is .ts/.tsx only (enforced by .gitignore:
 * apps/web/app/**\/*.js). Runs automatically before dev and build.
 */
import { readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

let removed = 0;
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (/\.js(\.map)?$/.test(entry.name)) {
      rmSync(full);
      removed++;
    }
  }
}

if (existsSync(appDir)) walk(appDir);
if (removed > 0) console.log(`[clean-app-js] removed ${removed} compiled .js/.js.map file(s) from app/`);
