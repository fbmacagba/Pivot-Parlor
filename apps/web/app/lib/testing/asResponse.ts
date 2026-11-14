// Test helper. Loaders and actions answer with `data(...)` (imported as json),
// which under React Router 7 is a plain { data, init } value, not a Response.
// Tests that call a route's loader or action directly read its answer through
// this, so their status, header and body checks stay as they were.

interface DataWithInit {
  type: "DataWithResponseInit";
  data: unknown;
  init: ResponseInit | null;
}

function isDataWithInit(value: unknown): value is DataWithInit {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "DataWithResponseInit";
}

/** The route's answer as a Response: a Response as is, a `data(...)` value as JSON with its status and headers. */
export function asResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (isDataWithInit(result)) {
    const headers = new Headers(result.init?.headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(result.data), { status: result.init?.status ?? 200, headers });
  }
  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
