import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every dashboard page handler (admin, staff, account, dev) must check the
// signed-in user's role itself, before it calls the API.
//
// A parent layout's gate does not protect its children. On a form POST Remix
// runs only the target route's action, and a `?_data=` request runs only the
// target route's loader. So `dev.tsx` gating on "developer" did nothing for
// `dev.activity`'s action, which forwards the irreversible audit "erase" with
// whatever session the request carries. The API refuses non-developers today;
// this keeps the dashboard from depending on that alone.
//
// The `api.*` routes are out of scope: they are JSON pass-throughs to the API
// for in-page fetches, where a redirect would be the wrong answer.
//
// vitest runs with cwd at the app root (apps/web); the "discovers" assertion
// fails loudly if that stops holding.
const routesDir = path.resolve(process.cwd(), "app/routes");

/** A call that checks the role, or a helper that does so as its first step. */
const GATE = /\b(requireRole|requireAuth|posLoader|posAction)\s*\(/;
/** The first point at which a handler can reach the API. */
const API_CALL = /\b(createApiClient|fetch|proxyShopPost)\s*\(/;

/** Handlers that need no check, each with the reason. */
const EXEMPT: Record<string, string> = {
  "staff.availability loader": "only redirects to /staff/bookings, which checks the role; reads no data",
};

type Handler = { route: string; kind: "loader" | "action"; body: string };

/** The handler's source from its `export` to the end of its body. */
export function handlerBody(src: string, kind: "loader" | "action"): string | null | "unterminated" {
  const text = src.replace(/\r\n/g, "\n");
  const m = text.match(new RegExp(`export (async )?function ${kind}\\b|export const ${kind}\\b`));
  if (!m || m.index === undefined) return null;
  const end = text.indexOf("\n}\n", m.index);
  if (end !== -1) return text.slice(m.index, end + 2);
  // One-line arrow form: `export const loader = (args) => helper(args);`
  const line = text.slice(m.index, text.indexOf("\n", m.index) + 1 || undefined);
  return /;\s*$/.test(line) ? line : "unterminated";
}

/** Why the handler fails the rule, or null when it passes. */
export function gateProblem(body: string): string | null {
  const gate = body.search(GATE);
  if (gate === -1) return "never checks the role";
  const call = body.search(API_CALL);
  if (call !== -1 && call < gate) return "reaches the API before checking the role";
  return null;
}

const pageFiles = readdirSync(routesDir).filter(
  (f) => /^(admin|staff|account|dev)(\.|$)/.test(f) && /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
);

const handlers: Handler[] = [];
const unparsed: string[] = [];
for (const f of pageFiles) {
  const src = readFileSync(path.join(routesDir, f), "utf8");
  const route = f.replace(/\.tsx?$/, "");
  for (const kind of ["loader", "action"] as const) {
    const body = handlerBody(src, kind);
    if (body === null) continue;
    if (body === "unterminated") unparsed.push(`${route} ${kind}`);
    else handlers.push({ route, kind, body });
  }
}

describe("dashboard page handlers check the role themselves", () => {
  it("discovers the dashboard page handlers", () => {
    expect(handlers.length).toBeGreaterThan(20);
    expect(unparsed).toEqual([]);
  });

  it("flags a handler that never checks (control)", () => {
    const body = handlerBody(
      "export async function action({ request }) {\n  const api = createApiClient(url, token);\n  return api.post('/x');\n}\n",
      "action",
    );
    expect(body).not.toBeNull();
    expect(gateProblem(body as string)).toBe("never checks the role");
  });

  it("flags a handler that calls the API before checking (control)", () => {
    const body = "export async function loader({ request }) {\n  const api = createApiClient(url, token);\n  await requireRole(request, 'developer', url);\n}\n";
    expect(gateProblem(handlerBody(body, "loader") as string)).toBe("reaches the API before checking the role");
  });

  it("counts a known-gated handler as gated (control)", () => {
    const own = handlers.find((h) => h.route === "dev.activity.export" && h.kind === "loader");
    expect(own).toBeDefined();
    expect(gateProblem(own!.body)).toBeNull();
  });

  it.each(Object.keys(EXEMPT))("exemption %s is still needed", (key) => {
    const h = handlers.find((x) => `${x.route} ${x.kind}` === key);
    expect(h, `${key} no longer exists: remove its exemption`).toBeDefined();
    expect(gateProblem(h!.body), `${key} now checks the role: remove its exemption`).not.toBeNull();
  });

  it("every other handler checks the role before calling the API", () => {
    const failing = handlers
      .filter((h) => !(`${h.route} ${h.kind}` in EXEMPT))
      .map((h) => ({ handler: `${h.route} ${h.kind}`, problem: gateProblem(h.body) }))
      .filter((r) => r.problem !== null)
      .map((r) => `${r.handler}: ${r.problem}`);
    expect(failing).toEqual([]);
  });
});
