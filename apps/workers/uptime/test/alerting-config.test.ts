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
import { STAGING_API_WORKER, toStagingWebToml } from "../../../../scripts/web-staging-toml.mjs";

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

/** Each `[[<prefix>ratelimits]]` block, with its `[<prefix>ratelimits.simple]` keys merged in. */
function rateLimits(toml: string, prefix: string): Record<string, string>[] {
  const blocks: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      if (line === `[[${prefix}ratelimits]]`) blocks.push((current = {}));
      else if (line !== `[${prefix}ratelimits.simple]`) current = null;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (current && m) current[m[1]] = m[2];
  }
  return blocks;
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

  it("the API rate-limits CSP violation reports in production and staging", () => {
    // Control: the reader finds a block, its simple table, and nothing when absent.
    const sample = "[[ratelimits]]\nname = \"L\"\nnamespace_id = \"1\"\n\n  [ratelimits.simple]\n  limit = 5\n  period = 10\n\n[vars]\nx = 1\n";
    expect(rateLimits(sample, "")).toEqual([{ name: "\"L\"", namespace_id: "\"1\"", limit: "5", period: "10" }]);
    expect(rateLimits(sample, "env.staging.")).toEqual([]);

    // Without the binding the endpoint has no limit, so this fails the suite
    // instead. The namespace ids are account-wide: 4201 and 4202 belong to
    // another project's worker.
    const toml = read(API);
    expect(rateLimits(toml, "")).toContainEqual({ name: "\"CSP_REPORT_LIMITER\"", namespace_id: "\"7101\"", limit: "20", period: "60" });
    expect(rateLimits(toml, "env.staging.")).toContainEqual({
      name: "\"CSP_REPORT_LIMITER\"",
      namespace_id: "\"7102\"",
      limit: "20",
      period: "60",
    });
  });

  it("the API rate-limits website error reports in production and staging", () => {
    // apps/worker/src/web-errors.ts: without the binding one failing route
    // could log without limit. 7101 and 7102 are the CSP limiter's.
    const toml = read(API);
    expect(rateLimits(toml, "")).toContainEqual({ name: "\"WEB_ERROR_LIMITER\"", namespace_id: "\"7103\"", limit: "30", period: "60" });
    expect(rateLimits(toml, "env.staging.")).toContainEqual({
      name: "\"WEB_ERROR_LIMITER\"",
      namespace_id: "\"7104\"",
      limit: "30",
      period: "60",
    });
  });

  it("the website hands its server errors to the API's WebErrors entrypoint", () => {
    // app/lib/serverErrors.ts reports over this binding; Pages Functions
    // have no Issues of their own. scripts/ci-set-web-staging-vars.mjs moves
    // it to the staging API, whose Issues are off (the next test).
    const web = read("apps/web/wrangler.toml");
    const services = web.split(/^\[\[services\]\]\s*$/m).slice(1);
    expect(services.some((block) =>
      /^binding\s*=\s*"WEB_ERRORS"\s*$/m.test(block) &&
      /^service\s*=\s*"pivot-parlor-api"\s*$/m.test(block) &&
      /^entrypoint\s*=\s*"WebErrors"\s*$/m.test(block),
    )).toBe(true);
  });

  it("the staging website deploy moves every binding off the production API", () => {
    // A WEB_ERRORS binding left on production would email the owner about
    // every staging E2E failure (scripts/ci-set-web-staging-vars.mjs).
    const prod = read("apps/web/wrangler.toml");
    const staging = toStagingWebToml(prod);
    const services = (toml: string) => [...toml.matchAll(/^service[ \t]*=[ \t]*"([^"]+)"/gm)].map((m) => m[1]);
    expect(services(prod)).toEqual(["pivot-parlor-api", "pivot-parlor-api"]);
    expect(services(staging)).toEqual([STAGING_API_WORKER, STAGING_API_WORKER]);
    expect(tomlValue(staging, "vars", "API_URL")).toBe("\"https://pivot-parlor-api-staging.bmorris0565.workers.dev\"");
    expect(tomlValue(staging, "vars", "APP_DOMAIN")).toBe("\"localhost\"");
    // Only those values change: no line is lost and a rerun changes nothing.
    expect(staging.split("\n")).toHaveLength(prod.split("\n").length);
    expect(toStagingWebToml(staging)).toBe(staging);
    // A production name the rewrite cannot place fails the deploy.
    const commented = prod.replace(/(binding = "WEB_ERRORS"\r?\nservice = "pivot-parlor-api")/, "$1 # production");
    expect(commented).not.toBe(prod);
    expect(() => toStagingWebToml(commented)).toThrow(/still names pivot-parlor-api/);
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
