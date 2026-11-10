/**
 * Pure schema comparison for the schema-drift guard (scripts/schema-drift.mjs).
 *
 * A database's schema is read from sqlite_master and DESCRIBED: each table as
 * its columns (by name, so column order never counts), its table-level
 * constraints and its options; each index, trigger and view as its CREATE
 * statement. Two descriptions are then compared key by key, and an allowlist
 * can accept differences known to be harmless, but only exactly as recorded.
 *
 * No imports: the module runs under Node (the CLI) and inside the worker test
 * pool (apps/worker/test/schema-drift.test.ts).
 */

// SQLite's own objects, D1's internal tables and the migration runner's
// bookkeeping table (the test harness replays the chain without it).
const IGNORED = /^(sqlite_|_cf_|d1_)/i;
const IGNORED_NAMES = new Set(["schema_migrations"]);

const CONSTRAINT_START = /^(constraint|primary key|unique|check|foreign key)\b/;

/** Normalise layout so only meaning is compared. Outside string literals:
 *  whitespace collapses, spaces around ( ) , go, simple identifier quoting
 *  goes, IF NOT EXISTS goes, and everything is lowercased. Literals are kept
 *  exactly ('Europe/London' and 'europe/london' differ). */
export function normalizeSql(sql) {
  const parts = String(sql ?? "").split("'");
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/"([A-Za-z0-9_]+)"|`([A-Za-z0-9_]+)`|\[([A-Za-z0-9_]+)\]/g, (_, a, b, c) => a ?? b ?? c)
      .replace(/\s+/g, " ")
      .replace(/\s*([(),])\s*/g, "$1")
      .replace(/\bif not exists /gi, "")
      .toLowerCase();
  }
  return parts.join("'").trim();
}

/** Split at depth-0 commas, never inside parentheses or string literals. */
function splitTopLevel(body) {
  const out = [];
  let depth = 0;
  let inLiteral = false;
  let current = "";
  for (const ch of body) {
    if (ch === "'") inLiteral = !inLiteral;
    if (!inLiteral) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function describeTable(sql) {
  const n = normalizeSql(sql);
  const open = n.indexOf("(");
  let depth = 0;
  let inLiteral = false;
  let close = -1;
  for (let i = open; i < n.length; i++) {
    const ch = n[i];
    if (ch === "'") inLiteral = !inLiteral;
    if (inLiteral) continue;
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  const columns = {};
  const constraints = [];
  for (const part of splitTopLevel(n.slice(open + 1, close))) {
    if (CONSTRAINT_START.test(part)) {
      constraints.push(part);
      continue;
    }
    const name = part.split(" ")[0];
    columns[name] = part.slice(name.length).trim();
  }
  return { columns: sortKeys(columns), constraints: constraints.sort(), options: n.slice(close + 1).trim() };
}

function sortKeys(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Describe sqlite_master rows ({ type, name, tbl_name, sql }). */
export function describeSchema(rows) {
  const tables = {};
  const indexes = {};
  const triggers = {};
  const views = {};
  for (const row of rows) {
    if (!row.sql || IGNORED.test(row.name) || IGNORED_NAMES.has(row.name)) continue;
    if (row.type === "table") tables[row.name] = describeTable(row.sql);
    else if (row.type === "index") indexes[row.name] = normalizeSql(row.sql);
    else if (row.type === "trigger") triggers[row.name] = normalizeSql(row.sql);
    else if (row.type === "view") views[row.name] = normalizeSql(row.sql);
  }
  return { tables: sortKeys(tables), indexes: sortKeys(indexes), triggers: sortKeys(triggers), views: sortKeys(views) };
}

const tableSummary = (t) => (t ? `columns: ${Object.keys(t.columns).join(", ")}` : null);
const joinConstraints = (t) => (t && t.constraints.length ? t.constraints.join(" | ") : null);
const tableOptions = (t) => (t && t.options ? t.options : null);

/** Every difference between two descriptions, sorted by key. Keys:
 *  table:<t>, table:<t>.column:<c>, table:<t>.constraints, table:<t>.options,
 *  index:<i>, trigger:<g>, view:<v>. A side that lacks the thing reads null. */
export function compareSchemas(live, chain) {
  const out = [];
  const push = (key, a, b) => {
    if (a !== b) out.push({ key, live: a, chain: b });
  };
  for (const name of union(live.tables, chain.tables)) {
    const a = live.tables[name];
    const b = chain.tables[name];
    if (!a || !b) {
      push(`table:${name}`, tableSummary(a), tableSummary(b));
      continue;
    }
    for (const col of union(a.columns, b.columns)) push(`table:${name}.column:${col}`, a.columns[col] ?? null, b.columns[col] ?? null);
    push(`table:${name}.constraints`, joinConstraints(a), joinConstraints(b));
    push(`table:${name}.options`, tableOptions(a), tableOptions(b));
  }
  for (const kind of ["indexes", "triggers", "views"]) {
    const prefix = { indexes: "index", triggers: "trigger", views: "view" }[kind];
    for (const name of union(live[kind], chain[kind])) push(`${prefix}:${name}`, live[kind][name] ?? null, chain[kind][name] ?? null);
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

function union(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/** The chain-side value a key reads in a description (what compareSchemas
 *  would report for that side), or null when the description lacks it. */
export function valueAt(description, key) {
  const m = key.match(/^(table|index|trigger|view):([^.]+)(?:\.(column:(.+)|constraints|options))?$/);
  if (!m) throw new Error(`Not a schema key: ${key}`);
  const [, kind, name, sub, column] = m;
  if (kind !== "table") return description[{ index: "indexes", trigger: "triggers", view: "views" }[kind]][name] ?? null;
  const t = description.tables[name];
  if (!sub) return tableSummary(t);
  if (!t) return null;
  if (column !== undefined) return t.columns[column] ?? null;
  return sub === "constraints" ? joinConstraints(t) : tableOptions(t);
}

/** Split differences into allowed (an entry matches key, live and chain
 *  exactly) and unexpected; entries matching nothing are stale. */
export function checkAllowlist(differences, allowlist) {
  const same = (d, e) => d.key === e.key && d.live === e.live && d.chain === e.chain;
  const allowed = differences.filter((d) => allowlist.some((e) => same(d, e)));
  const unexpected = differences.filter((d) => !allowlist.some((e) => same(d, e)));
  const stale = allowlist.filter((e) => !differences.some((d) => same(d, e)));
  return { allowed, unexpected, stale };
}

/** Compare a database's recorded migrations with the ones this branch has. */
export function migrationState(applied, expected) {
  const a = new Set(applied);
  const e = new Set(expected);
  return { pending: expected.filter((n) => !a.has(n)), unknown: applied.filter((n) => !e.has(n)) };
}
