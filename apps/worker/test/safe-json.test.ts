import { describe, expect, it } from "vitest";
import { safeJsonParse } from "@repo/utils";

describe("safeJsonParse (T6.5)", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns null for null/undefined/empty input", () => {
    expect(safeJsonParse(null)).toBeNull();
    expect(safeJsonParse(undefined)).toBeNull();
    expect(safeJsonParse("")).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(safeJsonParse("{not json}")).toBeNull();
    expect(safeJsonParse("[1,2,")).toBeNull();
    expect(safeJsonParse("undefined")).toBeNull();
  });
});
