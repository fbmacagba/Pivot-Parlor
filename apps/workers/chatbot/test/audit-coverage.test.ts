import { describe, expect, it, vi } from "vitest";
import { isAuditAction } from "@repo/audit";
import app from "../src/index";
import { ROUTE_AUDIT } from "../src/registry";

vi.mock("../src/ensure-schema", () => ({ assertChatbotSchema: async () => undefined }));

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);

// Hono records every `.use("*", ...)` registration in `.routes` as method
// "ALL" too. Scoped to "ALL" only, so a real POST/PUT/PATCH/DELETE route is
// never skipped.
function isWildcardMiddleware(method: string, path: string): boolean {
  return method === "ALL" && (path === "*" || path.endsWith("/*"));
}

function mutatingRoutes(): string[] {
  return [
    ...new Set(
      app.routes
        .filter((r) => MUTATING.has(r.method) && !isWildcardMiddleware(r.method, r.path))
        .map((r) => `${r.method} ${r.path}`)
    ),
  ].sort();
}

describe("audit coverage (chatbot worker)", () => {
  it("every mutating route of the chatbot app is declared", () => {
    expect(mutatingRoutes().filter((k) => !(k in ROUTE_AUDIT))).toEqual([]);
  });

  it("the route registry has no stale entries", () => {
    const live = new Set(mutatingRoutes());
    expect(Object.keys(ROUTE_AUDIT).filter((k) => !live.has(k))).toEqual([]);
  });

  it("the app really has the chat route (the enumeration is not vacuous)", () => {
    expect(mutatingRoutes()).toContain("POST /chat");
  });

  it("every declaration is a catalogue action", () => {
    expect(Object.values(ROUTE_AUDIT).filter((a) => !isAuditAction(a))).toEqual([]);
  });
});
