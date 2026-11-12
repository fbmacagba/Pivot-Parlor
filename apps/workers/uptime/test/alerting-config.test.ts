/// <reference types="node" />
/**
 * Production alerting is configuration, and configuration drifts silently:
 * a Wrangler deploy without `[observability.issues] enabled = true` turns
 * Workers Issues OFF, and a Wrangler older than 4.134.0 does not know the key
 * at all. Nothing else would notice either, so these guards fail the suite.
 * See docs/runbooks/production-alerting.md.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (rel: string) => readFileSync(ROOT + rel, "utf8");

/** The raw value of `key` in TOML table `section` ("" = before any table). */
function tomlValue(toml: string, section: string, key: string): string | undefined {
  let current = "";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

const ISSUES_MIN_WRANGLER = "4.134.0";
const API = "apps/worker/wrangler.toml";
const BOOKING = "apps/workers/booking/wrangler.toml";
const UPTIME = "apps/workers/uptime/wrangler.toml";
/**
 * The AI workers (the builder directory deploys as pivot-parlor-assembler),
 * each deployed by hand from the repo root's Wrangler. None has a staging env.
 */
const AI_WORKERS = ["builder", "chatbot", "images", "research", "text"].map((dir) => `apps/workers/${dir}`);

describe("production alerting configuration", () => {
  it("control: the TOML reader reports a missing table or key as absent", () => {
    const toml = "name = \"x\"\n[observability]\nenabled = true\n[observability.issues]\n# enabled = true\n";
    expect(tomlValue(toml, "", "name")).toBe("\"x\"");
    expect(tomlValue(toml, "observability", "enabled")).toBe("true");
    expect(tomlValue(toml, "observability.issues", "enabled")).toBeUndefined();
    expect(tomlValue(toml, "env.staging.observability.issues", "enabled")).toBeUndefined();
    expect(atLeast("4.105.0", ISSUES_MIN_WRANGLER)).toBe(false);
    expect(atLeast("4.134.0", ISSUES_MIN_WRANGLER)).toBe(true);
  });

  it("the production API and booking workers report errors to Workers Issues", () => {
    for (const file of [API, BOOKING]) {
      expect(tomlValue(read(file), "observability.issues", "enabled"), file).toBe("true");
    }
  });

  it("the AI workers report errors to Workers Issues", () => {
    for (const dir of AI_WORKERS) {
      const file = `${dir}/wrangler.toml`;
      const toml = read(file);
      expect(tomlValue(toml, "observability", "enabled"), file).toBe("true");
      expect(tomlValue(toml, "observability.issues", "enabled"), file).toBe("true");
      // A staging env here would inherit Issues and email the owner from test runs.
      expect(toml, file).not.toMatch(/^\[+env\./m);
    }
  });

  it("staging keeps Issues off, so E2E runs never email the owner", () => {
    for (const file of [API, BOOKING]) {
      expect(tomlValue(read(file), "env.staging.observability.issues", "enabled"), file).toBe("false");
    }
  });

  it("the uptime monitor runs every 5 minutes, reports to Issues and has no public route", () => {
    const toml = read(UPTIME);
    expect(tomlValue(toml, "", "name")).toBe("\"pivot-parlor-uptime\"");
    expect(tomlValue(toml, "triggers", "crons")).toBe("[\"*/5 * * * *\"]");
    expect(tomlValue(toml, "observability.issues", "enabled")).toBe("true");
    expect(tomlValue(toml, "", "workers_dev")).toBe("false");
    expect(tomlValue(toml, "", "compatibility_flags")).toContain("global_fetch_strictly_public");
    // The firing control is a deploy-time --var only; in [vars] it would page forever.
    expect(tomlValue(toml, "vars", "CONTROL_FAIL")).toBeUndefined();
  });

  it(`the Wrangler that deploys them knows the Issues setting (${ISSUES_MIN_WRANGLER} or later)`, () => {
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
    const hoisted = lock.packages["node_modules/wrangler"]?.version ?? "0.0.0";
    expect(atLeast(hoisted, ISSUES_MIN_WRANGLER), `hoisted wrangler ${hoisted}`).toBe(true);
    for (const pkg of ["apps/worker", "apps/workers/booking", "apps/workers/uptime"]) {
      const range = (JSON.parse(read(`${pkg}/package.json`)) as { devDependencies?: Record<string, string> }).devDependencies?.wrangler ?? "";
      const floor = range.replace(/^[\^~>=\s]+/, "");
      expect(atLeast(floor, ISSUES_MIN_WRANGLER), `${pkg} declares wrangler ${range}`).toBe(true);
    }
    // The AI workers are workspaces that resolve the hoisted copy; a nested older
    // copy under one of them would win for `npx wrangler deploy` in that directory.
    for (const dir of AI_WORKERS) {
      const nested = lock.packages[`${dir}/node_modules/wrangler`]?.version;
      if (nested) expect(atLeast(nested, ISSUES_MIN_WRANGLER), `${dir} nests wrangler ${nested}`).toBe(true);
    }
  });
});
