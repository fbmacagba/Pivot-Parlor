// @vitest-environment node
/** /.well-known/security.txt (RFC 9116): how a researcher reports a security problem.
 *
 *  It is a static file (public/.well-known/security.txt), served by Pages before
 *  the router. The domain receives no email, so the contact is the contact
 *  page. Expires is required and must be renewed before it passes: this test
 *  fails 30 days ahead, and renewing is one line (keep it under a year ahead).
 *  scripts/smoke-build.mjs checks the built site serves it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB = process.cwd();
const FILE = path.resolve(WEB, "public/.well-known/security.txt");
const DAY_MS = 24 * 60 * 60 * 1000;

function fields(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z-]+): (\S.*)$/);
    if (!m) throw new Error(`not a "Field: value" line: ${JSON.stringify(line)}`);
    const name = m[1].toLowerCase();
    out.set(name, [...(out.get(name) ?? []), m[2]]);
  }
  return out;
}

describe("security.txt", () => {
  it("exists where RFC 9116 puts it", () => {
    expect(existsSync(FILE)).toBe(true);
  });

  const text = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";

  it("names the contact page as the one contact, a page the site has", () => {
    const f = fields(text);
    expect(f.get("contact")).toEqual(["https://pivotparlor.com/contact"]);
    expect(existsSync(path.resolve(WEB, "app/routes/_marketing.contact.tsx"))).toBe(true);
  });

  it("names its own canonical address and English", () => {
    const f = fields(text);
    expect(f.get("canonical")).toEqual(["https://pivotparlor.com/.well-known/security.txt"]);
    expect(f.get("preferred-languages")).toEqual(["en"]);
  });

  it("expires once, in UTC, at most a year ahead and not within 30 days (renew it)", () => {
    const f = fields(text);
    const expires = f.get("expires") ?? [];
    expect(expires).toHaveLength(1);
    expect(expires[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    const left = Date.parse(expires[0]) - Date.now();
    expect(left, "security.txt Expires is within 30 days: renew it (under a year ahead)").toBeGreaterThan(30 * DAY_MS);
    expect(left).toBeLessThanOrEqual(366 * DAY_MS);
  });

  it("has no field RFC 9116 does not define", () => {
    const known = ["acknowledgments", "canonical", "contact", "encryption", "expires", "hiring", "policy", "preferred-languages", "csaf"];
    expect([...fields(text).keys()].filter((k) => !known.includes(k))).toEqual([]);
  });
});
