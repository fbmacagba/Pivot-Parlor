/**
 * Split a migration file into executable statements. Shared by
 * scripts/migrate.mjs and apps/worker/test/apply-schema.ts so the production
 * applier and the test replay can never disagree.
 *
 * Comment lines are stripped FIRST (a ';' inside a comment would split the
 * file mid-comment). A CREATE TRIGGER body contains ';' before its END, so
 * trigger segments are re-joined until the segment that ends with END.
 */
const TRIGGER_START = /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const ENDS_WITH_END = /\bEND$/i;

export function statements(sql) {
  const parts = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";");
  const out = [];
  let trigger = null;
  for (const raw of parts) {
    const part = raw.trim();
    if (trigger !== null) {
      trigger += ";" + raw;
      if (ENDS_WITH_END.test(part)) {
        out.push(trigger.trim());
        trigger = null;
      }
      continue;
    }
    if (!part) continue;
    if (TRIGGER_START.test(part) && !ENDS_WITH_END.test(part)) {
      trigger = raw;
      continue;
    }
    out.push(part);
  }
  if (trigger !== null) {
    throw new Error(`Unterminated CREATE TRIGGER (missing END;): ${trigger.trim().slice(0, 120)}`);
  }
  return out;
}
