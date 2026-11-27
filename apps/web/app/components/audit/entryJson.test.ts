import { describe, expect, it } from "vitest";
import { parseChanges, parseDetails } from "./entryJson";

// One malformed entry used to take the whole Activity page down: both values
// went straight into JSON.parse during render.

describe("parseChanges", () => {
  it("is null when the entry carries no changes", () => {
    expect(parseChanges(null)).toBeNull();
    expect(parseChanges("")).toBeNull();
  });

  it("turns before/after pairs into rows, with 'none' for an empty side", () => {
    expect(parseChanges('{"website_status":["live","paused"],"phone":[null,"0161"]}')).toEqual({
      ok: true,
      rows: [
        { field: "website_status", before: "live", after: "paused" },
        { field: "phone", before: "none", after: "0161" },
      ],
    });
  });

  it("answers ok: false for text that is not JSON, instead of throwing", () => {
    expect(parseChanges('{"website_status":["live","pau')).toEqual({ ok: false });
    expect(parseChanges("not json")).toEqual({ ok: false });
  });

  it("answers ok: false for JSON that is not an object of fields", () => {
    expect(parseChanges("null")).toEqual({ ok: false });
    expect(parseChanges("[1,2]")).toEqual({ ok: false });
    expect(parseChanges('"text"')).toEqual({ ok: false });
  });

  it("shows a value that is not a before/after pair rather than crashing on it", () => {
    expect(parseChanges('{"price_pence":1200,"tags":{"a":1}}')).toEqual({
      ok: true,
      rows: [
        { field: "price_pence", before: "", after: "1200" },
        { field: "tags", before: "", after: '{"a":1}' },
      ],
    });
  });
});

describe("parseDetails", () => {
  it("is null when there are none", () => {
    expect(parseDetails(null)).toBeNull();
  });

  it("pretty-prints details that parse", () => {
    expect(parseDetails('{"shop_type":"both"}')).toEqual({ ok: true, pretty: '{\n  "shop_type": "both"\n}' });
  });

  it("answers ok: false for details that do not parse, instead of throwing", () => {
    expect(parseDetails('{"shop_type":')).toEqual({ ok: false });
  });
});
