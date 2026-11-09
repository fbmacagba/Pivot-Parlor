import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// User-facing copy carries no em or en dashes (CLAUDE.md design rules). The
// copy-bearing JSX attributes (placeholder, title, aria-label, alt, label)
// reach users verbatim, so every line of an app .tsx file that sets one is
// checked. The worker's twin is apps/worker/test/no-dashes-in-errors.test.ts.
//
// vitest runs with cwd at the app root (apps/web); the "reads the files"
// assertion below fails loudly if that ever stops holding.
const appDir = path.resolve(process.cwd(), "app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith(".tsx") && !e.name.includes(".test.") ? [p] : [];
  });
}

const DASH = /[–—]/;
const COPY_ATTRIBUTE = /\b(placeholder|title|aria-label|alt|label)=/;

function dashedAttributeLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => COPY_ATTRIBUTE.test(line) && DASH.test(line));
}

describe("copy-bearing JSX attributes", () => {
  it("reads the files it claims to check", () => {
    expect(tsxFiles(appDir).length).toBeGreaterThan(50);
    expect(dashedAttributeLines("placeholder={`0–${n}`}")).toHaveLength(1);
    expect(dashedAttributeLines('aria-label="Close — dialog"')).toHaveLength(1);
    expect(dashedAttributeLines('placeholder="Type a message…"')).toHaveLength(0);
  });

  it("contain no em or en dashes", () => {
    const offenders = tsxFiles(appDir).flatMap((file) =>
      dashedAttributeLines(readFileSync(file, "utf8")).map(
        (line) => `${path.relative(appDir, file)}: ${line.trim()}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
