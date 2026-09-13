import { describe, it, expect } from "vitest";
import { extractJsonObject, stripCodeFences } from "../src/index";

describe("stripCodeFences", () => {
  it("removes ```json and ``` markers and trims", () => {
    expect(stripCodeFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });
});

describe("extractJsonObject", () => {
  it("returns a fenced object without the fences", () => {
    expect(extractJsonObject("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("returns the first balanced object when prose surrounds it", () => {
    expect(extractJsonObject('Sure! Here it is: {"a":{"b":[1,2]}} Hope that helps.')).toBe(
      '{"a":{"b":[1,2]}}',
    );
  });

  it("ignores braces inside string values", () => {
    expect(extractJsonObject('{"text":"a } b { c","n":1} trailing')).toBe('{"text":"a } b { c","n":1}');
  });

  it("ignores escaped quotes inside strings", () => {
    const src = '{"q":"she said \\"}\\"","n":2}';
    expect(extractJsonObject(src + " tail")).toBe(src);
  });

  it("returns the stripped text when there is no object", () => {
    expect(extractJsonObject("  no json here ")).toBe("no json here");
  });

  it("returns from the first brace to the end when the object never closes", () => {
    expect(extractJsonObject('{"a":1')).toBe('{"a":1');
  });
});
