/**
 * Split a migration file into executable statements. Shared by
 * scripts/migrate.mjs and apps/worker/test/apply-schema.ts so the production
 * applier and the test replay can never disagree.
 *
 * Comment lines are stripped FIRST (a ';' inside a comment would split the
 * file mid-comment). A CREATE TRIGGER body contains ';' before its END, so
 * trigger segments are re-joined until the trigger's own BEGIN...END closes.
 *
 * A trigger body may itself contain a `CASE ... END` expression, whose END
 * is not the trigger's closing END. Rather than matching literally on the
 * text ending with END, a trigger segment is complete only once it has seen
 * strictly more whole-word END tokens than whole-word CASE tokens: each
 * CASE consumes one END, and the trigger's own BEGIN...END contributes
 * exactly one END that no CASE consumes.
 */
const TRIGGER_START = /^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const END_TOKEN = /\bEND\b/gi;
const CASE_TOKEN = /\bCASE\b/gi;

function countTokens(re, text) {
  return (text.match(re) || []).length;
}

function isComplete(text) {
  return countTokens(END_TOKEN, text) > countTokens(CASE_TOKEN, text);
}

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
      if (isComplete(trigger)) {
        out.push(trigger.trim());
        trigger = null;
      }
      continue;
    }
    if (!part) continue;
    if (TRIGGER_START.test(part) && !isComplete(part)) {
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
