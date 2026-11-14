// One-off for the React Router 7 move (docs/superpowers/plans/2026-11-14-react-router-7.md,
// Task 6): rewrites the website's Remix 2 imports to React Router 7's. The move's last
// task deletes this file and its test.
//
// Usage: node scripts/rr7-rename-imports.mjs <files...>
// Rewrites the files in place. If any file holds a name this script does not know,
// nothing is written and it exits 1.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Where each Remix module's names now live. */
const TARGET = {
  "@remix-run/react": "react-router",
  "@remix-run/cloudflare": "react-router",
  "@remix-run/cloudflare-pages": "@react-router/cloudflare",
  "@remix-run/server-runtime": "react-router",
};
const TARGET_MODULES = new Set(Object.values(TARGET));

/** React Router 7 renames these entry components; Task 7 edits their two files by hand. */
const HAND_EDITED = new Set(["RemixBrowser", "RemixServer"]);

/** The @remix-run/cloudflare names the website uses, all exported by react-router. */
const CLOUDFLARE_NAMES = new Set([
  "json",
  "LoaderFunctionArgs",
  "ActionFunctionArgs",
  "MetaFunction",
  "redirect",
  "AppLoadContext",
  "EntryContext",
  "HandleErrorFunction",
  "HeadersFunction",
  "LinksFunction",
]);

const IMPORT = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+(["'])([^"']+)\3;?[ \t]*(\r?\n)?/gm;
const MAX_LINE = 100;

/** @param {string} spec @param {string} mod */
function renameSpecifier(spec, mod) {
  const inline = /^type\s+/.test(spec);
  const [name, alias] = spec.replace(/^type\s+/, "").split(/\s+as\s+/);
  if (mod === "@remix-run/react" && HAND_EDITED.has(name)) {
    throw new Error(`${name} from @remix-run/react is renamed by hand (Task 7), not by this script`);
  }
  if (mod === "@remix-run/cloudflare") {
    if (!CLOUDFLARE_NAMES.has(name)) throw new Error(`${name} from @remix-run/cloudflare is not a name this script knows`);
    if (name === "json") return `${inline ? "type " : ""}data as ${alias ?? "json"}`;
  }
  return spec;
}

/** @param {boolean} typeOnly @param {string[]} specs @param {string} mod @param {string} eol */
function formatImport(typeOnly, specs, mod, eol) {
  const head = `import ${typeOnly ? "type " : ""}`;
  const oneLine = `${head}{ ${specs.join(", ")} } from "${mod}";`;
  if (oneLine.length <= MAX_LINE) return oneLine + eol;
  return `${head}{${eol}${specs.map((s) => `  ${s},`).join(eol)}${eol}} from "${mod}";${eol}`;
}

/**
 * @param {string} source
 * @returns {{ source: string, changed: boolean }}
 */
export function renameImports(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let out = source;

  const matches = [...source.matchAll(IMPORT)].filter((m) => m[4] in TARGET || TARGET_MODULES.has(m[4]));
  if (matches.some((m) => m[4] in TARGET)) {
    // target module -> { value: specs[], type: specs[] }, in order of first appearance.
    /** @type {Map<string, { value: string[], type: string[] }>} */
    const groups = new Map();
    for (const m of matches) {
      const [, typeKw, clause, , mod] = m;
      const target = TARGET[mod] ?? mod;
      const specs = clause.split(",").map((s) => s.trim()).filter(Boolean);
      const renamed = mod in TARGET ? specs.map((s) => renameSpecifier(s, mod)) : specs;
      if (!groups.has(target)) groups.set(target, { value: [], type: [] });
      const bucket = groups.get(target)[typeKw ? "type" : "value"];
      for (const s of renamed) if (!bucket.includes(s)) bucket.push(s);
    }
    let block = "";
    for (const [mod, { value, type }] of groups) {
      if (value.length) block += formatImport(false, value, mod, eol);
      if (type.length) block += formatImport(true, type, mod, eol);
    }
    // Put the merged block where the first of these imports was, and drop the rest.
    let first = true;
    out = source.replace(IMPORT, (whole, _t, _c, _q, mod) => {
      if (!(mod in TARGET || TARGET_MODULES.has(mod))) return whole;
      if (!first) return "";
      first = false;
      return block;
    });
  }

  // Module names inside test mocks. `typeof import(...)` first: it can sit inside
  // vi.importActual's type argument.
  out = out
    .replace(/(typeof import\(\s*)(["'])@remix-run\/react\2/g, "$1$2react-router$2")
    .replace(/(vi\.importActual(?:<[^>]*>)?\(\s*)(["'])@remix-run\/react\2/g, "$1$2react-router$2")
    .replace(/(vi\.mock\(\s*)(["'])@remix-run\/react\2/g, "$1$2react-router$2");

  return { source: out, changed: out !== source };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const files = process.argv.slice(2);
  const results = [];
  const failures = [];
  for (const file of files) {
    try {
      results.push({ file, ...renameImports(readFileSync(file, "utf8")) });
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    console.error(`Nothing written. ${failures.length} file(s) need a hand edit:\n${failures.join("\n")}`);
    process.exit(1);
  }
  const changed = results.filter((r) => r.changed);
  for (const r of changed) writeFileSync(r.file, r.source);
  console.log(`changed ${changed.length} of ${files.length} files`);
}
