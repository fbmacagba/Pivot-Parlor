/**
 * The fields an update actually changed, as `{ field: [before, after] }`
 * for an audit entry's `changes` (the recorder then filters them through
 * CHANGE_ALLOWLIST), plus their sorted names for `details.fields`.
 *
 * - A key of `after` whose value is `undefined` was not submitted: ignored.
 * - A missing `before` (a create) or a missing key counts as null.
 * - The comparison is strict, on primitives.
 */
export function fieldChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): { changes: Record<string, [unknown, unknown]>; fields: string[] } {
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(after)) {
    if (after[k] === undefined) continue;
    const prev = before?.[k] ?? null;
    const next = after[k] ?? null;
    if (prev !== next) changes[k] = [prev, next];
  }
  return { changes, fields: Object.keys(changes).sort() };
}
