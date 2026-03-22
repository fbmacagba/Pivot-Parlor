import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const buildDir = join(__dirname, "..", "build");

try {
  rmSync(buildDir, { recursive: true, force: true });
  console.log("✓ clean-build: removed build/");
} catch (err) {
  console.warn("! clean-build: failed to remove build/", err);
}

