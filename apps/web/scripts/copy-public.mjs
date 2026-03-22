import { mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = join(__dirname, "..");
const publicDir = join(root, "public");
const outDir = join(root, "build", "client");

mkdirSync(outDir, { recursive: true });

if (existsSync(publicDir)) {
  cpSync(publicDir, outDir, { recursive: true });
  console.log("✓ copy-public: copied public/ → build/client/");
} else {
  console.log("ℹ copy-public: no public/ directory found");
}

