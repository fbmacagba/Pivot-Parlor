/** /logout must end the server session, not only the browser's cookie: the
 *  API keeps `session:<token>` in KV until POST /auth/logout deletes it, so a
 *  copied token stayed valid for its full 7 days after the user signed out.
 *  Lives in lib/ rather than routes/ so Remix never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, loader } from "~/routes/logout";

const API_URL = "https://api.test";
const context = { env: { API_URL, APP_DOMAIN: "pivotparlor.com" } };

function request(method: "GET" | "POST", cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("Cookie", cookie);
  return new Request("https://pivotparlor.com/logout", { method, headers });
}

const run = {
  action: (req: Request) => action({ request: req, context, params: {} } as never),
  loader: (req: Request) => loader({ request: req, context, params: {} } as never),
};

function expectSignedOut(res: Response) {
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/login");
  const cookies = res.headers.get("Set-Cookie") ?? "";
  expect(cookies).toContain("pp_session=;");
  expect(cookies).toContain("Max-Age=0");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(["action", "loader"] as const)("logout %s", (kind) => {
  const method = kind === "action" ? "POST" : "GET";

  it("revokes the session on the API with the cookie's token, then signs out", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await run[kind](request(method, "theme=dark; pp_session=tok.abc.123"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_URL}/auth/logout`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok.abc.123");
    expectSignedOut(res);
  });

  it("still signs out when the API cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    expectSignedOut(await run[kind](request(method, "pp_session=tok.abc.123")));
  });

  it("still signs out when the API refuses the revoke", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false, error: "x" }, { status: 503 })));
    expectSignedOut(await run[kind](request(method, "pp_session=tok.abc.123")));
  });

  it("makes no API call without a session cookie", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expectSignedOut(await run[kind](request(method)));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
