/**
 * A post-sign-in redirect target taken from the query string or a form field.
 * Returns a same-site path, or null when the value could take the visitor to
 * another site.
 *
 * A browser does not read a Location header literally. It drops tab, CR and
 * LF anywhere in the URL, and in http(s) URLs it reads "\" as "/". So
 * "/\evil.example" and "/<TAB>/evil.example" both become "//evil.example",
 * a different site. Both passed the old prefix checks (measured 2026-11-06).
 * The value is therefore rejected on any control character or backslash, then
 * resolved exactly as a browser would and kept only if it stays on our origin.
 */
const CHECK_ORIGIN = "https://redirect-check.invalid";

export function safeRedirectPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.startsWith("/") || t.startsWith("//")) return null;
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    // C0 controls (tab, CR, LF and the rest), DEL, and the backslash.
    if (code < 0x20 || code === 0x7f || code === 0x5c) return null;
  }
  // Kept from the original guard: no scheme-like or credential-like parts.
  if (t.includes(":") || t.includes("@")) return null;
  let resolved: URL;
  try {
    resolved = new URL(t, CHECK_ORIGIN);
  } catch {
    return null;
  }
  if (resolved.origin !== CHECK_ORIGIN) return null;
  // Return the checked value itself, never the normalised path: normalising
  // "/..//evil.example" yields "//evil.example", which a browser would read as
  // another site. The value as given resolves on our origin (checked above).
  return t;
}
