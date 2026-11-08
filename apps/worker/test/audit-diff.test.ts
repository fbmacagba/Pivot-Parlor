import { describe, expect, it } from "vitest";
import { fieldChanges } from "../src/audit/diff";

describe("fieldChanges", () => {
  it("returns only changed keys", () => {
    expect(fieldChanges({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ changes: { b: [2, 3] }, fields: ["b"] });
  });

  it("treats a missing before as null", () => {
    expect(fieldChanges(null, { a: 1 }).changes).toEqual({ a: [null, 1] });
  });

  it("ignores undefined after-values", () => {
    expect(fieldChanges({ a: 1 }, { a: undefined }).fields).toEqual([]);
  });
});
