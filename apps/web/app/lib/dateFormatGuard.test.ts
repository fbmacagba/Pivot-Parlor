/**
 * Dates, times and counts are formatted only in app/lib/dateFormat.ts.
 *
 * A page renders on the server (en-US, UTC) and again in the visitor's
 * browser; anything formatted with the defaults differs between the two,
 * fails hydration and, in British Summer Time, shows times an hour early.
 * The first live load of the browser alert (2026-11-12) caught exactly that
 * on /dev. This test fails on any such call outside dateFormat.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.resolve(__dirname, "..");
const MODULE = path.join(APP, "lib", "dateFormat.ts");

const RULES: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\.toLocale(?:Date|Time)?String\(|\.to(?:Date|Time)String\(/g,
    why: "formats in the machine's language or zone: use formatDate, formatTime, formatDateTime, formatDay or formatCount",
  },
  {
    pattern: /\.get(?:Hours|Minutes|TimezoneOffset)\(\)/g,
    why: "reads the machine's clock: use ukParts",
  },
];

// Intl.DateTimeFormat( ... ) whose arguments do not name a timeZone.
function unzonedIntl(source: string): number[] {
  const offsets: number[] = [];
  const re = /Intl\.DateTimeFormat\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    if (!/\btimeZone\b/.test(source.slice(m.index, i))) offsets.push(m.index);
  }
  return offsets;
}

/** Comments blanked out, line breaks kept, so a note about a call is not a call. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_c, before: string) => before);
}

export function violations(source: string): Array<{ line: number; text: string; why: string }> {
  const src = code(source);
  const lineOf = (offset: number) => src.slice(0, offset).split("\n").length;
  const found: Array<{ line: number; text: string; why: string }> = [];
  for (const rule of RULES) {
    for (const m of src.matchAll(rule.pattern)) found.push({ line: lineOf(m.index ?? 0), text: m[0], why: rule.why });
  }
  for (const offset of unzonedIntl(src)) {
    found.push({ line: lineOf(offset), text: "Intl.DateTimeFormat(", why: "has no timeZone" });
  }
  return found.sort((a, b) => a.line - b.line);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && full !== MODULE ? [full] : [];
  });
}

describe("date formatting stays in app/lib/dateFormat.ts", () => {
  it("control: the scanner finds each kind of call, and ignores comments", () => {
    const sample = [
      "const a = new Date(x).toLocaleString();",
      "const b = d.toLocaleDateString('en-GB', { day: 'numeric' });",
      "const c = n.toLocaleString('en-GB');",
      "const e = d.toTimeString();",
      "const f = new Date().getHours();",
      "const g = new Intl.DateTimeFormat('en-GB', { hour: 'numeric' });",
      "const h = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric' });",
      "// d.toLocaleString() in a comment",
      "/* new Date().getMinutes() */",
      "const url = 'https://example.test'; const i = d.toLocaleTimeString();",
    ].join("\n");
    expect(violations(sample).map((v) => v.line)).toEqual([1, 2, 3, 4, 5, 6, 10]);
  });

  it("no file formats a date, a time or a count on its own", () => {
    const files = sourceFiles(APP);
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) =>
      violations(readFileSync(file, "utf8")).map((v) => `${path.relative(APP, file)}:${v.line} ${v.text} ${v.why}`),
    );
    expect(found).toEqual([]);
  });
});
