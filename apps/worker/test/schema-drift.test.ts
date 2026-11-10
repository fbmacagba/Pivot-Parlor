/**
 * The schema-drift guard (scripts/schema-drift.mjs).
 *
 * Production's schema differed from the migration chain three times (the P14
 * index, the ai_usage_log CHECK, the reviews CASCADE), each invisible to tests
 * that replay the chain. The guard reads a live database's sqlite_master and
 * compares it with apps/worker/src/db/chain-schema.json, the chain's schema as
 * this suite replays it, less the differences schema-drift-allowlist.json
 * accepts for that database.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  checkAllowlist,
  compareSchemas,
  describeSchema,
  migrationState,
  normalizeSql,
  valueAt,
  type AllowlistEntry,
  type SchemaRow,
} from "../../../scripts/schema-compare.mjs";
import allowlist from "../src/db/schema-drift-allowlist.json";

const table = (name: string, sql: string): SchemaRow => ({ type: "table", name, tbl_name: name, sql });
const index = (name: string, tbl: string, sql: string | null): SchemaRow => ({ type: "index", name, tbl_name: tbl, sql });
const trigger = (name: string, tbl: string, sql: string): SchemaRow => ({ type: "trigger", name, tbl_name: tbl, sql });
const diff = (live: SchemaRow[], chain: SchemaRow[]) => compareSchemas(describeSchema(live), describeSchema(chain));

const T = "CREATE TABLE t (id TEXT PRIMARY KEY, a INTEGER NOT NULL DEFAULT 0, b TEXT)";

async function replayedChainRows(): Promise<SchemaRow[]> {
  const { results } = await env.DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all<SchemaRow>();
  return results ?? [];
}

describe("normalizeSql", () => {
  it("ignores layout, identifier quoting and IF NOT EXISTS", () => {
    expect(normalizeSql('CREATE TABLE IF NOT EXISTS "t" (\r\n  id   TEXT PRIMARY KEY ,\n  n INTEGER DEFAULT ( 0 )\n)')).toBe(
      normalizeSql("create table t(id text primary key,n integer default(0))")
    );
  });

  it("keeps the case and spacing inside string literals", () => {
    expect(normalizeSql("x TEXT DEFAULT 'Europe/London'")).not.toBe(normalizeSql("x TEXT DEFAULT 'europe/london'"));
    expect(normalizeSql("x TEXT DEFAULT 'a  b'")).toBe("x text default 'a  b'");
    expect(normalizeSql("X TEXT DEFAULT 'it''s'")).toBe("x text default 'it''s'");
  });
});

describe("compareSchemas", () => {
  it("finds nothing when only column order and layout differ", () => {
    expect(diff([table("t", "CREATE TABLE t (b TEXT, id TEXT PRIMARY KEY,\n  a INTEGER NOT NULL DEFAULT 0)")], [table("t", T)])).toEqual([]);
  });

  it("names a column whose definition differs", () => {
    expect(diff([table("t", T.replace("DEFAULT 0", "DEFAULT 1"))], [table("t", T)])).toEqual([
      { key: "table:t.column:a", live: "integer not null default 1", chain: "integer not null default 0" },
    ]);
  });

  it("names a column present on one side only", () => {
    expect(diff([table("t", T.replace("b TEXT", "b TEXT, c TEXT"))], [table("t", T)])).toEqual([
      { key: "table:t.column:c", live: "text", chain: null },
    ]);
  });

  it("names a foreign key that lost its cascade (the reviews case)", () => {
    expect(
      diff(
        [table("r", "CREATE TABLE r (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, FOREIGN KEY (shop_id) REFERENCES shops(id))")],
        [table("r", "CREATE TABLE r (id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE)")]
      )
    ).toEqual([
      { key: "table:r.column:shop_id", live: "text not null", chain: "text not null references shops(id)on delete cascade" },
      { key: "table:r.constraints", live: "foreign key(shop_id)references shops(id)", chain: null },
    ]);
  });

  it("names tables, indexes and triggers that are missing or differ", () => {
    expect(
      diff(
        [table("t", T), table("extra", "CREATE TABLE extra (id TEXT, n INTEGER)"), trigger("g", "t", "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END")],
        [table("t", T), index("i", "t", "CREATE INDEX i ON t(a)"), trigger("g", "t", "CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 2; END")]
      )
    ).toEqual([
      { key: "index:i", live: null, chain: "create index i on t(a)" },
      { key: "table:extra", live: "columns: id, n", chain: null },
      { key: "trigger:g", live: "create trigger g after insert on t begin select 1; end", chain: "create trigger g after insert on t begin select 2; end" },
    ]);
  });

  it("compares table options such as WITHOUT ROWID", () => {
    expect(
      diff([table("k", "CREATE TABLE k (key TEXT PRIMARY KEY) WITHOUT ROWID")], [table("k", "CREATE TABLE k (key TEXT PRIMARY KEY)")])
    ).toEqual([{ key: "table:k.options", live: "without rowid", chain: null }]);
  });

  it("ignores SQLite's, D1's and the migration runner's own objects", () => {
    expect(
      diff(
        [
          table("t", T),
          index("sqlite_autoindex_t_1", "t", null),
          table("_cf_KV", "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID"),
          table("d1_migrations", "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY)"),
          table("schema_migrations", "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY)"),
        ],
        [table("t", T)]
      )
    ).toEqual([]);
  });
});

describe("checkAllowlist", () => {
  const found = [{ key: "table:t.column:a", live: "integer default 1", chain: "integer not null default 0" }];
  const entry = (live: string): AllowlistEntry => ({ key: "table:t.column:a", live, chain: "integer not null default 0", reason: "test" });

  it("accepts a difference the allowlist describes exactly", () => {
    expect(checkAllowlist(found, [entry("integer default 1")])).toEqual({ allowed: found, unexpected: [], stale: [] });
  });

  it("rejects an allowlisted key whose live definition has changed, and reports the entry as stale", () => {
    expect(checkAllowlist(found, [entry("integer default 2")])).toEqual({ allowed: [], unexpected: found, stale: [entry("integer default 2")] });
  });

  it("reports an entry whose difference has gone as stale", () => {
    expect(checkAllowlist([], [entry("integer default 1")])).toEqual({ allowed: [], unexpected: [], stale: [entry("integer default 1")] });
  });
});

describe("migrationState", () => {
  it("lists migrations the database has not run yet", () => {
    expect(migrationState(["000_schema", "001_a"], ["000_schema", "001_a", "002_b"])).toEqual({ pending: ["002_b"], unknown: [] });
  });

  it("lists migrations the database ran that this branch does not have", () => {
    expect(migrationState(["000_schema", "001_a", "003_other_branch"], ["000_schema", "001_a"])).toEqual({
      pending: [],
      unknown: ["003_other_branch"],
    });
  });
});

describe("the chain snapshot", () => {
  it("src/db/chain-schema.json matches the replayed chain (after a migration, update it: npx vitest run test/schema-drift.test.ts -u)", async () => {
    const description = describeSchema(await replayedChainRows());
    expect(Object.keys(description.tables)).toContain("reviews");
    await expect(`${JSON.stringify(description, null, 2)}\n`).toMatchFileSnapshot("../src/db/chain-schema.json");
  });
});

describe("the drift allowlist", () => {
  it("still describes a real difference from the replayed chain, with a reason, for every entry", async () => {
    const chain = describeSchema(await replayedChainRows());
    const databases = allowlist as Record<string, AllowlistEntry[]>;
    expect(Object.keys(databases).sort()).toEqual(["pivot-parlor-db", "pivot-parlor-db-staging"]);
    for (const [database, entries] of Object.entries(databases)) {
      for (const entry of entries) {
        expect(valueAt(chain, entry.key), `${database} ${entry.key}`).toBe(entry.chain);
        expect(entry.live, `${database} ${entry.key}`).not.toBe(entry.chain);
        expect(entry.reason.length, `${database} ${entry.key}`).toBeGreaterThan(40);
      }
    }
  });
});
