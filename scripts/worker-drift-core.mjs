// Pure helpers for scripts/worker-drift.mjs: no I/O, so the worker test suite
// can pin them (apps/worker/test/worker-drift.test.ts).

/** Workers that CI deploys on every merge; every other apps/workers folder deploys by hand. */
export const CI_DEPLOYED = ["booking"];

/** The worker's top-level `name` in wrangler.toml (before any [section]), or null. */
export function workerScriptName(toml) {
  for (const line of toml.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("[")) return null;
    const m = t.match(/^name\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

/** The hand-deployed workers, sorted by folder: [{ dir, script }]. Throws on a folder with no name. */
export function handDeployedWorkers(entries, ciDeployed = CI_DEPLOYED) {
  return entries
    .filter((e) => !ciDeployed.includes(e.dir))
    .map((e) => {
      const script = workerScriptName(e.toml);
      if (!script) throw new Error(`apps/workers/${e.dir}/wrangler.toml has no top-level name`);
      return { dir: e.dir, script };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The boundary from a multipart Content-Type header, or null. */
export function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  return m ? (m[1] ?? m[2]) : null;
}

function indexOf(haystack, needle, from) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * The parts of a multipart body, byte for byte: [{ name, filename, body: Uint8Array }].
 * A part's name is read from its own Content-Disposition, exactly, so
 * "index.js" never matches "index.js.map".
 */
export function multipartParts(bytes, boundary) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const delimiter = enc.encode(`--${boundary}`);
  const crlfcrlf = enc.encode("\r\n\r\n");
  const parts = [];
  let at = indexOf(bytes, delimiter, 0);
  while (at >= 0) {
    const afterDelim = at + delimiter.length;
    // "--" right after a delimiter closes the body.
    if (bytes[afterDelim] === 0x2d && bytes[afterDelim + 1] === 0x2d) break;
    const headStart = afterDelim + 2; // skip CRLF
    const headEnd = indexOf(bytes, crlfcrlf, headStart);
    if (headEnd < 0) break;
    const next = indexOf(bytes, delimiter, headEnd + 4);
    if (next < 0) break;
    const headers = dec.decode(bytes.subarray(headStart, headEnd));
    const name = /name="([^"]*)"/i.exec(headers.replace(/filename="[^"]*"/i, ""))?.[1] ?? "";
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1] ?? null;
    // The CRLF before the next delimiter belongs to the delimiter, not the body.
    parts.push({ name, filename, body: bytes.subarray(headEnd + 4, next - 2) });
    at = next;
  }
  return parts;
}

/** The parts Cloudflare runs: every module, without source maps. */
export function deployedModules(parts) {
  return parts.filter((p) => !p.name.endsWith(".map"));
}

/**
 * Compares { moduleName: sha256 } maps. An empty build never matches: a
 * dry run that produced nothing has proved nothing.
 */
export function compareBundles(local, live) {
  const names = (o) => Object.keys(o).sort();
  const changed = names(local).filter((n) => n in live && live[n] !== local[n]);
  const missing = names(local).filter((n) => !(n in live));
  const extra = names(live).filter((n) => !(n in local));
  const match = names(local).length > 0 && changed.length === 0 && missing.length === 0 && extra.length === 0;
  return { match, changed, missing, extra };
}
