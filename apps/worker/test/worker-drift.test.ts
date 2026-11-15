/**
 * The hand-deployed worker drift check (scripts/worker-drift.mjs).
 *
 * Six background workers deploy by hand, so main can move on while
 * production keeps running an older build, and nothing said so. The check
 * builds each one with `wrangler deploy --dry-run` and compares every module
 * with what Cloudflare runs (GET .../workers/scripts/<name>/content/v2, a
 * multipart body with one part per module plus its source map).
 */
import { describe, expect, it } from "vitest";
import {
  boundaryOf,
  compareBundles,
  deployedModules,
  handDeployedWorkers,
  multipartParts,
  workerScriptName,
} from "../../../scripts/worker-drift-core.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A content/v2 body the way Cloudflare sends it: CRLF lines, one part per file. */
function contentV2(boundary: string, parts: Array<[string, string, string]>): Uint8Array {
  const chunks = parts.map(
    ([name, type, body]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n`,
  );
  return enc.encode(`${chunks.join("")}--${boundary}--\r\n`);
}

describe("multipartParts", () => {
  const B = "f969bef513464e9e5233";
  const js = 'export default { fetch() { return new Response("ok"); } };\n//# sourceMappingURL=index.js.map\n';
  const map = '{"version":3,"sources":["index.js"],"mappings":"AAAA"}';

  // The 2026-11-15 misread: matching "index.js" anywhere in a part's headers
  // also matches "index.js.map", and the source map was hashed as the bundle.
  it("keeps index.js and index.js.map apart, each byte for byte", () => {
    const parts = multipartParts(contentV2(B, [["index.js", "application/javascript+module", js], ["index.js.map", "application/source-map", map]]), B);
    expect(parts.map((p) => p.name)).toEqual(["index.js", "index.js.map"]);
    expect(dec.decode(parts[0]!.body)).toBe(js);
    expect(dec.decode(parts[1]!.body)).toBe(map);
  });

  it("drops source maps from the deployed modules, and keeps every other module", () => {
    const parts = multipartParts(
      contentV2(B, [
        ["index.js", "application/javascript+module", js],
        ["index.js.map", "application/source-map", map],
        ["chunk-a.js", "application/javascript+module", "export const a = 1;\n"],
      ]),
      B,
    );
    expect(deployedModules(parts).map((p) => p.name)).toEqual(["index.js", "chunk-a.js"]);
  });

  it("keeps binary module bytes intact", () => {
    const head = enc.encode(`--${B}\r\nContent-Disposition: form-data; name="m.wasm"; filename="m.wasm"\r\nContent-Type: application/wasm\r\n\r\n`);
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x0a, 0xff, 0x2d, 0x2d]);
    const tail = enc.encode(`\r\n--${B}--\r\n`);
    const body = new Uint8Array([...head, ...wasm, ...tail]);
    const [part] = multipartParts(body, B);
    expect(part!.name).toBe("m.wasm");
    expect([...part!.body]).toEqual([...wasm]);
  });

  it("reads the boundary from the response's Content-Type", () => {
    expect(boundaryOf('multipart/form-data; boundary="abc123"')).toBe("abc123");
    expect(boundaryOf("multipart/form-data; boundary=f969bef5")).toBe("f969bef5");
    expect(boundaryOf("application/json")).toBeNull();
  });
});

describe("compareBundles", () => {
  it("matches when every module has the same hash", () => {
    expect(compareBundles({ "index.js": "aa" }, { "index.js": "aa" })).toEqual({ match: true, changed: [], missing: [], extra: [] });
  });

  it("names a changed, a missing and an extra module", () => {
    const r = compareBundles({ "index.js": "aa", "chunk.js": "bb" }, { "index.js": "cc", "old.js": "dd" });
    expect(r).toEqual({ match: false, changed: ["index.js"], missing: ["chunk.js"], extra: ["old.js"] });
  });

  it("never matches an empty build (a dry run that produced nothing proves nothing)", () => {
    expect(compareBundles({}, {}).match).toBe(false);
  });
});

describe("which workers are checked", () => {
  it("reads the top-level name, not an environment's", () => {
    const toml = 'name = "pivot-parlor-booking"\nmain = "src/index.ts"\n\n[env.staging]\nname = "pivot-parlor-booking-staging"\n';
    expect(workerScriptName(toml)).toBe("pivot-parlor-booking");
  });

  it("allows comments and blank lines before the name", () => {
    expect(workerScriptName('# Uptime monitor\n\nname = "pivot-parlor-uptime"\n')).toBe("pivot-parlor-uptime");
  });

  it("checks every worker folder except the CI-deployed booking worker", () => {
    const dirs = ["booking", "builder", "chatbot", "images", "research", "text", "uptime"].map((dir) => ({
      dir,
      toml: `name = "pivot-parlor-${dir === "builder" ? "assembler" : dir}"\n`,
    }));
    expect(handDeployedWorkers(dirs)).toEqual([
      { dir: "builder", script: "pivot-parlor-assembler" },
      { dir: "chatbot", script: "pivot-parlor-chatbot" },
      { dir: "images", script: "pivot-parlor-images" },
      { dir: "research", script: "pivot-parlor-research" },
      { dir: "text", script: "pivot-parlor-text" },
      { dir: "uptime", script: "pivot-parlor-uptime" },
    ]);
  });

  it("refuses a worker folder whose wrangler.toml has no name", () => {
    expect(() => handDeployedWorkers([{ dir: "mystery", toml: 'main = "src/index.ts"\n' }])).toThrow(/mystery/);
  });

  // Only an environment named: the production script name is unknown, so
  // comparing the staging script would prove nothing about production.
  it("treats a name that appears only under an environment as no name", () => {
    const toml = 'main = "src/index.ts"\n\n[env.staging]\nname = "pivot-parlor-mystery-staging"\n';
    expect(workerScriptName(toml)).toBeNull();
  });
});
