#!/usr/bin/env node
// scripts/pages-deploy.mjs
// Wraps wrangler pages deploy with a sanitised commit message.
// Strips emojis and non-ASCII chars that break Cloudflare's API (code 8000111).

import { execSync } from "node:child_process";

// Get last git commit message and strip anything non-ASCII
let commitMsg = "deploy";
try {
  const raw = execSync("git log -1 --pretty=%s", { encoding: "utf8" }).trim();
  commitMsg = raw
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    || "deploy";
} catch { /* use default */ }

console.log(`Deploying with commit message: "${commitMsg}"`);

execSync(
  `npx wrangler pages deploy ./.pages-dist --project-name=pivot-parlor-web --branch=main --commit-dirty=true --commit-message="${commitMsg}"`,
  { stdio: "inherit", shell: true }
);
