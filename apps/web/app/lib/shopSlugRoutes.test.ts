import { afterEach, describe, expect, it, vi } from "vitest";
import { requireShopSlug } from "./shopSlug";

// Route modules import UI hooks and components from @remix-run/react, which
// does not resolve react in this test environment (the other route tests mock
// it too). Loaders and actions never call them, so any name is a stub.
// lucide-react has the same problem. ("then" stays undefined, or the mock
// would look like a promise.)
vi.mock("@remix-run/react", () =>
  new Proxy(
    { __esModule: true },
    { get: (target, key) => (key === "then" ? undefined : key in target ? target[key as "__esModule"] : () => null) },
  ),
);
vi.mock("lucide-react", () =>
  new Proxy(
    { __esModule: true },
    { get: (target, key) => (key === "then" ? undefined : key in target ? target[key as "__esModule"] : () => null) },
  ),
);

// The shop routes put the slug from the URL into API paths and into every link
// on the page. On production 2026-11-11 a slug of
// \example.com\..\..\..\..\api\shops\linden-and-lark-demo resolved to the
// real Linden shop at the API and rendered links to https://example.com/...
// Every loader and action under $shopSlug must refuse such a slug before it
// fetches anything. The glob picks up new shop routes automatically.

const TRAVERSAL = "\\example.com\\..\\..\\..\\..\\api\\shops\\linden-and-lark-demo";

type Handler = (args: { params: Record<string, string>; request: Request; context: unknown }) => Promise<unknown> | unknown;
const modules = import.meta.glob("../routes/$shopSlug*.tsx", { eager: true }) as Record<
  string,
  { loader?: Handler; action?: Handler }
>;
const handlers = Object.entries(modules).flatMap(([file, mod]) =>
  (["loader", "action"] as const)
    .filter((kind) => typeof mod[kind] === "function")
    .map((kind) => [file.replace("../routes/", ""), kind, mod[kind] as Handler] as const),
);

async function call(fn: Handler, kind: "loader" | "action", shopSlug: string): Promise<unknown> {
  const request = new Request("https://pivotparlor.com/x", { method: kind === "action" ? "POST" : "GET" });
  try {
    return await fn({ params: { shopSlug }, request, context: { env: { API_URL: "https://api.test" } } });
  } catch (thrown) {
    return thrown;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireShopSlug", () => {
  it.each(["ferdyms-barber-shop-014", "linden-and-lark-demo", "0b1c2d3e-aaaa-bbbb-cccc-123456789abc", "pp-demo-linden-lark"])(
    "accepts %s",
    (slug) => {
      expect(requireShopSlug({ shopSlug: slug })).toBe(slug);
    },
  );

  it.each([TRAVERSAL, "Linden-And-Lark-Demo", "a.b", "a/b", "a\\b", "a b", "", undefined])("refuses %j with a 404", (slug) => {
    let thrown: unknown;
    try {
      requireShopSlug({ shopSlug: slug });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });
});

describe("$shopSlug routes", () => {
  it("covers every shop loader and action", () => {
    // layout, book, confirm, manifest, waitlist and walkin loaders; book and
    // waitlist actions.
    expect(handlers.length).toBeGreaterThanOrEqual(8);
  });

  it.each(handlers)("%s %s refuses a traversal slug with a 404, before any fetch", async (_file, kind, fn) => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const outcome = await call(fn, kind, TRAVERSAL);
    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it("still sends a well-formed slug to the API (the guard is about shape, not a blanket refusal)", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ success: false, error: "Not found" }) }));
    vi.stubGlobal("fetch", f);
    const layout = handlers.find(([file, kind]) => file === "$shopSlug.tsx" && kind === "loader")!;
    const outcome = await call(layout[2], "loader", "no-such-shop-123");
    expect((outcome as Response).status).toBe(404);
    expect(f).toHaveBeenCalledWith("https://api.test/api/shops/no-such-shop-123", expect.anything());
  });
});
