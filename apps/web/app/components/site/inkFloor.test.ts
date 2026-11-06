/** Source guard: shop text never takes an ink step below 40.
 *
 *  siteTheme lifts ink steps 40 and up to a readable (4.5:1) alpha on light
 *  and dark palettes alike; steps below 40 stay raw for rules and decoration.
 *  Text on a lower step failed in the browser (the chat hint at --st-ink-30
 *  measured 1.85:1 on the salon palette, 2.38:1 on the barber palette). */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// vitest runs from apps/web (jsdom gives import.meta.url a non-file scheme).
// The second test below fails if this ever points at the wrong tree.
const APP = resolve(process.cwd(), "app");

// Decorative, aria-hidden glyphs that may sit on a low step on purpose.
const ALLOWED = new Map<string, string>([
  ["components/site/sections/bits.tsx", "StarRow empty stars, inside aria-hidden"],
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("ink floor for text", () => {
  it("no text colour uses an --st-ink step below 40", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(APP)) {
      const rel = relative(APP, file).split(sep).join("/");
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/text-\[color:var\(--st-ink-(\d{1,2})\)\]/g)) {
          if (Number(m[1]) < 40) offenders.push(`${rel}:${i + 1} ink-${m[1]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("scans the shop chrome (the guard is pointed at real files)", () => {
    const files = sourceFiles(APP).map((f) => relative(APP, f).split(sep).join("/"));
    expect(files).toContain("components/CommercialShopChrome.tsx");
    expect(files).toContain("components/site/sections/bits.tsx");
  });
});
