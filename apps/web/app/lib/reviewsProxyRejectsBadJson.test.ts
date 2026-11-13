/** The public review proxy (/api/shops/:shopId/reviews) forwards a visitor's
 *  review to the API. A body that is not a JSON object is the caller's mistake:
 *  it gets a 400 and never reaches the API, instead of throwing (a 500 on the
 *  site, and an error alert to the owner). Lives in lib/ rather than routes/ so
 *  Remix never mounts it as a route. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { action } from "~/routes/api.shops.$shopId.reviews";

const API_URL = "https://api.test";
const context = { env: { API_URL } };

function stubApi(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Response.json({ success: true, data: { id: "r-1" } }, { status: 201 });
    }),
  );
  return urls;
}

function post(body: string): Request {
  return new Request("https://pivotparlor.com/api/shops/shop-1/reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

const run = (request: Request) =>
  action({ request, params: { shopId: "shop-1" }, context } as unknown as Parameters<typeof action>[0]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("review proxy", () => {
  it.each(["this is not json {", "", "null", "[]", "42"])(
    "answers %j with 400 'Invalid JSON' and never calls the API",
    async (raw) => {
      const urls = stubApi();
      const res = await run(post(raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: "Invalid JSON" });
      expect(urls).toEqual([]);
    },
  );

  it("forwards a JSON object to the API unchanged (control)", async () => {
    const urls = stubApi();
    const review = { customer_name: "Casey", rating: 5, body: "Great cut", booking_id: "b-1" };
    const res = await run(post(JSON.stringify(review)));
    expect(res.status).toBe(201);
    expect(urls).toEqual([`${API_URL}/api/shops/shop-1/reviews`]);
    const sent = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(sent.body as string)).toEqual(review);
  });
});
