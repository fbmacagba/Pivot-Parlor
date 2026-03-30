#!/usr/bin/env node
// scripts/pages-deploy.mjs
// Wraps wrangler pages deploy with a sanitised commit message.
// Strips emojis and non-ASCII chars that break Cloudflare's API (code 8000111).

import { execSync, spawnSync } from "node:child_process";

// Get last git commit message and strip anything non-ASCII
let commitMsg = "deploy";
try {
  const raw = execSync("git log -1 --pretty=%s", { encoding: "utf8" }).trim();
  // Remove emojis and non-ASCII characters
  commitMsg = raw
    .replace(/[^\x00-\x7F]/g, "")  // strip non-ASCII (covers all emojis)
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim()
    .slice(0, 200)                   // max 200 chars
    || "deploy";
} catch { /* use default */ }

console.log(`Deploying with commit message: "${commitMsg}"`);

const result = spawnSync(
  "npx",
  [
    "wrangler", "pages", "deploy", "./.pages-dist",
    "--project-name=pivot-parlor-web",
    "--branch=main",
    "--commit-dirty=true",
    `--commit-message=${commitMsg}`,
  ],
  { stdio: "inherit", shell: true }
);

process.exit(result.status ?? 0);
