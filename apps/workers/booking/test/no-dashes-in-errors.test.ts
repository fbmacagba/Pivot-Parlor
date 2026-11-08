/** User-facing copy carries no em or en dashes (CLAUDE.md design rules). The
 *  API's `error` strings reach users verbatim through the dashboards, so every
 *  line of a route file that sets `error:` is checked. */
import { describe, expect, it } from "vitest";

const routes = import.meta.glob("../src/routes/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

const DASH = /[–—]/;

function dashedErrorLines(source: string): string[] {
  return source.split("\n").filter((line) => /\berror:/.test(line) && DASH.test(line));
}

describe("route error strings", () => {
  it("reads the route files it claims to check", () => {
    expect(Object.keys(routes).length).toBeGreaterThan(5);
    expect(dashedErrorLines('return c.json({ error: "a — b" });')).toHaveLength(1);
    expect(dashedErrorLines('return c.json({ error: "1–5" });')).toHaveLength(1);
  });

  it("contain no em or en dashes", () => {
    const offenders = Object.entries(routes).flatMap(([file, src]) =>
      dashedErrorLines(src).map((line) => `${file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
