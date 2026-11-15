// @vitest-environment node
/** asResponse turns a loader's or action's answer into the Response a resource
 *  route sends, the way React Router 7 does it, and adds nothing of its own: a
 *  test reading a status, header or body through it sees what the wire carries. */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { data } from "react-router";
import { describe, expect, it } from "vitest";
import { asResponse } from "./asResponse";

describe("asResponse", () => {
  it("a data() value answers as Response.json, with its status and headers", async () => {
    const res = asResponse(data({ success: false, error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ success: false, error: "Unauthorized" });
  });

  it("a data() value with no init answers 200", async () => {
    const res = asResponse(data({ ok: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it("keeps a Content-Type the route set", () => {
    const res = asResponse(data("a,b", { headers: { "Content-Type": "text/csv" } }));
    expect(res.headers.get("content-type")).toBe("text/csv");
  });

  it("a string answers as plain text, any other value as Response.json", async () => {
    const text = asResponse("hello");
    expect(text.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await text.text()).toBe("hello");
    const value = asResponse({ a: 1 });
    expect(value.headers.get("content-type")).toBe("application/json");
    expect(await value.json()).toEqual({ a: 1 });
  });

  it("a Response passes through untouched", () => {
    const original = new Response("x", { status: 418 });
    expect(asResponse(original)).toBe(original);
  });

  it("mirrors the conversions in the installed React Router", () => {
    // The package entry re-exports chunk files beside it; read them all.
    const dist = path.dirname(createRequire(path.resolve(process.cwd(), "package.json")).resolve("react-router"));
    const source = readdirSync(dist)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => readFileSync(path.join(dist, f), "utf8"))
      .join("\n");
    // data(value, init) from a loader or action.
    expect(source).toMatch(/function dataWithResponseInitToResponse\(\w+\) \{\s*return Response\.json\((\w+)\.data, \1\.init \?\? void 0\);/);
    // Any other value a resource route returns.
    expect(source).toMatch(/typeof result === "string"\) \{\s*return new Response\(result\);\s*\}\s*return Response\.json\(result\);/);
  });
});
