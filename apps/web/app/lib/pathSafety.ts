/**
 * Path-traversal guards for values that come from a URL and end up in another
 * URL.
 *
 * Found on production 2026-11-11: a shop page at
 * /%5Cexample.com%5C..%5C..%5C..%5C..%5Capi%5Cshops%5Clinden-and-lark-demo
 * rendered the real Linden shop (HTTP 200). Remix decoded the segment into the
 * slug param, the loader put it into an API URL where `\` became `/` and the
 * `..` segments resolved back to /api/shops/linden-and-lark-demo, and every
 * link on the page was built from the slug: href="/\example.com\..." resolves
 * to https://example.com/...
 */

/** C0 control characters and DEL: the URL parser strips tab and newlines. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when a request path smuggles a separator, a control character or a
 * second encoding layer into one segment. Remix decodes each segment into a
 * route param, so this is exactly what a param could carry. The URL parser has
 * already resolved literal `\`, `..` and pure %2e dot segments, so only
 * segments with a `%` need decoding.
 */
export function hasUnsafePathSegment(pathname: string): boolean {
  for (const raw of pathname.split("/")) {
    if (!raw.includes("%")) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return true;
    }
    if (/[\\/%]/.test(segment) || hasControlChar(segment) || segment === "." || segment === "..") return true;
  }
  return false;
}

// The URL standard's single-dot and double-dot segments (case-insensitive).
const DOT_SEGMENTS = new Set([".", "%2e", "..", ".%2e", "%2e.", "%2e%2e"]);

/**
 * True when an outgoing API path would change when the URL parser resolves
 * it: a backslash (a separator in http URLs), a tab or newline (stripped), or
 * a dot segment in the path part. The query is left alone; it is not resolved.
 */
export function isTraversalApiPath(path: string): boolean {
  if (hasControlChar(path)) return true;
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname.includes("\\")) return true;
  return pathname.split("/").some((segment) => DOT_SEGMENTS.has(segment.toLowerCase()));
}
