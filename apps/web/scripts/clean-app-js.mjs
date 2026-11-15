#!/usr/bin/env node
/**
 * Remove compiled .js / .js.map twins from app/.
 *
 * Route discovery (flatRoutes) reads .js as well as .tsx, and a compiled
 * twin is the same route ID: the router keeps whichever file it reads first
 * and only logs a route ID collision, so a stale twin can be served instead
 * of its edited .tsx source. App source is .ts/.tsx only (enforced by .gitignore:
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
