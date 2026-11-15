// Test helper. Loaders and actions answer with `data(...)` (imported as json),
// which under React Router 7 is a plain { data, init } value, not a Response.
// Tests that call a route's loader or action directly read its answer through
// this, so their status, header and body checks stay as they were.
//
// It converts the way React Router does for a resource route, and adds nothing
// of its own (asResponse.test.ts pins both conversions against the installed
// router): `data(value, init)` becomes `Response.json(value, init)`, a string a
// plain-text Response, any other value `Response.json(value)`. A page route's
// answer is rendered into the page instead; this shows what its action returned.

interface DataWithInit {
  type: "DataWithResponseInit";
  data: unknown;
  init: ResponseInit | null;
}

function isDataWithInit(value: unknown): value is DataWithInit {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "DataWithResponseInit";
}

/** The route's answer as the Response React Router would send for it. */
export function asResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (isDataWithInit(result)) return Response.json(result.data, result.init ?? undefined);
  if (typeof result === "string") return new Response(result);
  return Response.json(result);
}
