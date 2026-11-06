/** Source guard: a <style> element never takes its CSS as a JSX text child.
 *
 *  React's server renderer escapes quotes and angle brackets in text, and a
 *  browser does not decode entities inside <style>, so the server's style text
 *  differs from the client's whenever the CSS holds a quote or `>`. The
 *  marketing chat widget's keyframes held [role="dialog"]: every marketing page
 *  (/, /pricing, /about) threw React #425/#418/#423 and re-rendered the whole
 *  document in the browser (measured 2026-11-06). Use
 *  <style dangerouslySetInnerHTML={{ __html: css }} /> for static CSS. */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

// vitest runs from apps/web (jsdom gives import.meta.url a non-file scheme).
const APP = resolve(process.cwd(), "app");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx|jsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("<style> elements take CSS as innerHTML", () => {
  it("no <style> opening tag carries children (it must self-close with dangerouslySetInnerHTML)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(APP)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<style\b([^>]*)>/g)) {
        if (m[1]!.trimEnd().endsWith("/")) continue; // <style ... />
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${relative(APP, file).split(sep).join("/")}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scans the marketing chat widget (the guard is pointed at real files)", () => {
    const files = sourceFiles(APP).map((f) => relative(APP, f).split(sep).join("/"));
    expect(files).toContain("components/marketing/MarketingChatbot.tsx");
  });

  it("innerHTML keeps the quotes a text child would have escaped", () => {
    const css = '[role="dialog"] > * { color: red }';
    expect(renderToString(createElement("style", { dangerouslySetInnerHTML: { __html: css } }))).toContain(css);
    // The failure mode this guards against: as a text child the quotes come out escaped.
    expect(renderToString(createElement("style", null, css))).not.toContain(css);
  });
});
