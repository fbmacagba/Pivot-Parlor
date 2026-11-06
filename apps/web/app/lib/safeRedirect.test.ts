/** safeRedirectPath: the post-sign-in redirect stays on this site.
 *  "/<backslash>evil.example" and "/<TAB>/evil.example" passed the old login
 *  guard and resolved to https://evil.example/ (measured 2026-11-06). */
import { describe, it, expect } from "vitest";
import { safeRedirectPath } from "./safeRedirect";

// Built from char codes so no escape sequence in this file can be rewritten.
const BS = String.fromCharCode(92); // backslash
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);

/** Where a browser would land for this Location value, from our login page. */
const landsOn = (path: string) => new URL(path, "https://pivotparlor.com/login").host;

describe("safeRedirectPath", () => {
  it("keeps ordinary same-site paths, with query and hash", () => {
    expect(safeRedirectPath("/admin")).toBe("/admin");
    expect(safeRedirectPath("/dev/shops?tab=review#candidate")).toBe("/dev/shops?tab=review#candidate");
    expect(safeRedirectPath("  /staff  ")).toBe("/staff");
  });

  it("rejects missing, relative and protocol-relative values", () => {
    for (const v of [null, undefined, "", "admin", "//evil.example", "///evil.example"]) {
      expect(safeRedirectPath(v), String(v)).toBeNull();
    }
  });

  it("rejects the browser-normalised bypasses (backslash, tab, CR, LF)", () => {
    const bypasses = [`/${BS}evil.example`, `/${TAB}/evil.example`, `/${LF}/evil.example`, `/${CR}/evil.example`];
    for (const v of bypasses) {
      // Each one really is an off-site redirect when a browser resolves it...
      expect(landsOn(v), JSON.stringify(v)).toBe("evil.example");
      // ...and the guard refuses it.
      expect(safeRedirectPath(v), JSON.stringify(v)).toBeNull();
    }
  });

  it("rejects other control characters and backslashes defensively", () => {
    for (const v of [`${BS}${BS}evil.example`, `/${NUL}/evil.example`, `/foo${BS}..${BS}${BS}evil.example`, `/a${String.fromCharCode(127)}`]) {
      expect(safeRedirectPath(v), JSON.stringify(v)).toBeNull();
    }
  });

  it("does not normalise dot segments into a protocol-relative URL", () => {
    // new URL() would turn these into the path "//evil.example"; returned as
    // given, a browser resolves them on our own host.
    for (const v of ["/..//evil.example", "/.//evil.example", "/a/..//evil.example"]) {
      const out = safeRedirectPath(v);
      expect(out, v).toBe(v);
      expect(landsOn(out!), v).toBe("pivotparlor.com");
    }
  });

  it("rejects scheme- and credential-like values", () => {
    for (const v of ["https://evil.example", "/javascript:alert(1)", "/@evil.example", "/x@evil.example"]) {
      expect(safeRedirectPath(v), v).toBeNull();
    }
  });

  it("never returns a value a browser would resolve off-site", () => {
    const probes = ["/admin", "/a/../b", "/%2F%2Fevil.example", "/./evil.example", "/%5Cevil.example", "/?next=//evil.example", "/..//evil.example", "/%09/evil.example"];
    for (const v of probes) {
      const out = safeRedirectPath(v);
      if (out !== null) expect(landsOn(out), `${v} -> ${out}`).toBe("pivotparlor.com");
    }
  });
});
