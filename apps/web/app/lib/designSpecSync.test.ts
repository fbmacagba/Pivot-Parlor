// Guards the synced designSpec copy in the research worker (standalone
// worker, no @repo imports). If this fails, re-copy the block between the
// SYNC markers from packages/utils/src/designSpec.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function syncBlock(path: string): string {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf("// SYNC-START designSpec");
  const end = text.indexOf("// SYNC-END designSpec");
  expect(start, `missing SYNC-START in ${path}`).toBeGreaterThan(-1);
  expect(end, `missing SYNC-END in ${path}`).toBeGreaterThan(start);
  return text.slice(start, end).replace(/\r\n/g, "\n");
}

describe("designSpec sync", () => {
  it("research worker copy matches @repo/utils byte for byte", () => {
    const root = resolve(__dirname, "../../../..");
    const canonical = syncBlock(resolve(root, "packages/utils/src/designSpec.ts"));
    const copy = syncBlock(resolve(root, "apps/workers/research/src/design-spec.ts"));
    expect(copy).toBe(canonical);
  });
});
