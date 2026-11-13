/**
 * A request body as a plain JSON object, or null when it is not one: not JSON,
 * empty, or JSON that is null, an array, a number or a string. Public routes
 * answer null with a 400, so a caller's malformed body never reaches code that
 * reads its fields, and never becomes a 500 (which records a failed action and
 * emails the owner).
 *
 * Takes anything with a json() method: a Fetch Request, or Hono's c.req (whose
 * parsed body is cached, so middleware and handler may both call this).
 */
export async function readJsonObject(source: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  let value: unknown;
  try {
    value = await source.json();
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An optional text field as a form sends it: absent, null, or a string. */
export function isOptionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}
