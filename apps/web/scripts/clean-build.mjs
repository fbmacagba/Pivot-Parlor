import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = join(__dirname, "..");
const buildDir = join(root, "build");
const pagesDist = join(root, ".pages-dist");

try {
  rmSync(buildDir, { recursive: true, force: true });
  console.log("✓ clean-build: removed build/");
} catch (err) {
  console.warn("! clean-build: failed to remove build/", err);
}

try {
  rmSync(pagesDist, { recursive: true, force: true });
  console.log("✓ clean-build: removed .pages-dist/");
} catch (err) {
  console.warn("! clean-build: failed to remove .pages-dist/", err);
}

