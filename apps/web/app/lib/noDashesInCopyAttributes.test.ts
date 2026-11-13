import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// User-facing copy carries no em or en dashes (CLAUDE.md design rules). Copy
// reaches people as JSX text, as copy-bearing attributes (placeholder, title,
// aria-label, alt, label) and as strings a component renders (toasts, empty
// cells, headings built in code). So every string literal, template part and
// JSX text node in an app .ts/.tsx file is checked; comments are not copy and
// are skipped. The worker's twin is apps/worker/test/no-dashes-in-errors.test.ts.
//
// vitest runs with cwd at the app root (apps/web); the "reads the files"
// assertion below fails loudly if that ever stops holding.
const appDir = path.resolve(process.cwd(), "app");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !e.name.includes(".test.") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

const DASH = /[–—]/;

/** The text of every string, template part and JSX text node holding a dash. */
export function dashedCopy(source: string, fileName = "x.tsx"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const text = ts.isJsxText(node) ? node.getText(file) : node.text;
      if (DASH.test(text)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        hits.push(`${line + 1}: ${text.trim().replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

describe("user-facing copy", () => {
  it("reads the files it claims to check", () => {
    expect(sourceFiles(appDir).length).toBeGreaterThan(100);
    expect(dashedCopy("const a = <p>Open 9–5</p>;")).toHaveLength(1);
    expect(dashedCopy('const a = <input placeholder="Search — all" />;')).toHaveLength(1);
    expect(dashedCopy("const t = `0–${n} left`;", "x.ts")).toHaveLength(1);
    expect(dashedCopy('toast("Saved — thanks");', "x.ts")).toHaveLength(1);
    expect(dashedCopy("// a comment — not copy\nconst a = 1; /* nor — this */", "x.ts")).toHaveLength(0);
    expect(dashedCopy('const a = <p title="Type a message…">Hi - there</p>;')).toHaveLength(0);
  });

  it("contains no em or en dashes", () => {
    const offenders = sourceFiles(appDir).flatMap((file) =>
      dashedCopy(readFileSync(file, "utf8"), file).map((hit) => `${path.relative(appDir, file)}:${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});
