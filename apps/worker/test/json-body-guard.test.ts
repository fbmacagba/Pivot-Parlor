import { describe, expect, it } from "vitest";

/**
 * Every JSON request body in this worker is read through readJsonObject
 * (@repo/utils), which answers a body that is not a JSON object with null
 * instead of throwing or handing the route a null, an array or a number.
 * A raw c.req.json() lets those through: `.catch(() => ({}))` still passes a
 * null body on, and the route's next property read throws (a 500, a failed
 * audit row and an Issues email). Routes whose entity lookup runs before the
 * body is parsed are out of reach of a request sweep, so this reads the source.
 */

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

/** Line and block comments removed, so a comment that names the call is not a finding. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const RAW_JSON_READ = /\breq\s*(?:\.\s*raw\s*)?\.\s*json\s*[<(]/g;

function rawReads(text: string): number {
  return code(text).match(RAW_JSON_READ)?.length ?? 0;
}

describe("JSON request bodies", () => {
  it("the check finds the raw reads it exists to forbid (control)", () => {
    expect(rawReads("const b = await c.req.json();")).toBe(1);
    expect(rawReads("const b = await c.req.json<{\n  a?: string;\n}>().catch(() => ({}));")).toBe(1);
    expect(rawReads("const b = await c.req.raw.json();")).toBe(1);
    expect(rawReads("const b = await c.req\n    .json<{ type?: string }>()\n    .catch(() => ({}));")).toBe(1);
    expect(rawReads("// c.req.json() used to throw here")).toBe(0);
    expect(rawReads("const b = await readJsonObject(c.req);")).toBe(0);
    expect(rawReads("const data = await res.json();")).toBe(0);
  });

  it("no source file reads a request body with a raw c.req.json()", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(40);
    const found = files
      .filter((f) => rawReads(sources[f]!) > 0)
      .map((f) => `${f.replace("../src/", "")} x${rawReads(sources[f]!)}`)
      .sort();
    expect(found).toEqual([]);
  });
});
