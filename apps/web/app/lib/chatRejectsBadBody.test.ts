/** The public marketing chat (/api/chat) sends visitors' messages to OpenRouter.
 *  A body that is not a JSON object, or `messages` that is not a list, is the
 *  caller's mistake: it gets the widget's own 400 and never reaches OpenRouter,
 *  instead of throwing (a 500 on the site, and an error alert to the owner).
 *  Lives in lib/ rather than routes/ so Remix never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/api.chat";

// No KV: the route's per-IP limit is skipped, so only the body decides.
const context = { env: { OPENROUTER_API_KEY: "test-key" } };

function stubOpenRouter(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Response.json({ choices: [{ message: { content: "Hello there." } }] });
    }),
  );
  return urls;
}

function post(body: string): Request {
  return new Request("https://pivotparlor.com/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body,
  });
}

const run = (request: Request) =>
  action({ request, params: {}, context } as unknown as Parameters<typeof action>[0]) as Promise<Response>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("marketing chat", () => {
  it.each(["this is not json {", "", "null", "[]", "42", '"text"', '{"messages":"hi"}', '{"messages":{"0":"hi"}}'])(
    "answers %j with 400 'Invalid request.' and never calls OpenRouter",
    async (raw) => {
      const urls = stubOpenRouter();
      const res = await run(post(raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid request." });
      expect(urls).toEqual([]);
    },
  );

  it("sends a real conversation to OpenRouter (control)", async () => {
    const urls = stubOpenRouter();
    const res = await run(post(JSON.stringify({ messages: [{ role: "user", content: "Hi" }] })));
    expect(res.status).toBe(200);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  });
});
