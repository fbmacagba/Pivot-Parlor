import { mkdirSync, cpSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = join(__dirname, "..");
const publicDir = join(root, "public");
const functionsDir = join(root, "functions");
const outDir = join(root, "build", "client");

// Ensure output dir exists
mkdirSync(outDir, { recursive: true });

// Copy all static assets from public → build/client
if (existsSync(publicDir)) {
  cpSync(publicDir, outDir, { recursive: true });
}

// Copy functions dir (e.g. _middleware.ts) so Pages sees it as part of the deployment
if (existsSync(functionsDir)) {
  const outFunctions = join(outDir, "functions");
  mkdirSync(outFunctions, { recursive: true });
  cpSync(functionsDir, outFunctions, { recursive: true });
}

console.log("✓ Copied public/ and functions/ into build/client for Pages deploy");

