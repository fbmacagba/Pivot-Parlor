import { rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const root = join(__dirname, "..");
const buildClient = join(root, "build", "client");
const functionsDir = join(root, "functions");
const deployDir = join(root, ".pages-dist");

// Fresh deploy folder
rmSync(deployDir, { recursive: true, force: true });
mkdirSync(deployDir, { recursive: true });

if (!existsSync(buildClient)) {
  throw new Error(`Missing build output at ${buildClient}. Run \`npm run build\` first.`);
}

// Static output at root so /assets/* works
cpSync(buildClient, deployDir, { recursive: true });

// Functions at root so Pages SSR works
if (existsSync(functionsDir)) {
  cpSync(functionsDir, join(deployDir, "functions"), { recursive: true });
}

console.log("✓ prepare-pages-deploy: created .pages-dist with static + functions");

