import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { statements } from "../../../scripts/sql-statements.mjs";

describe("statements()", () => {
  it("splits plain statements and drops comment lines", () => {
    const sql = "-- a comment; with a semicolon\nCREATE TABLE a (x INTEGER);\n\nINSERT INTO a VALUES (1);";
    expect(statements(sql)).toEqual(["CREATE TABLE a (x INTEGER)", "INSERT INTO a VALUES (1)"]);
  });

  it("keeps a trigger body in one statement", () => {
    const sql = [
      "CREATE TABLE t (x INTEGER);",
      "CREATE TRIGGER t_no_delete BEFORE DELETE ON t",
      "BEGIN",
      "  SELECT RAISE(ABORT, 'no');",
      "END;",
      "INSERT INTO t VALUES (1);",
    ].join("\n");
    const out = statements(sql);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatch(/^CREATE TRIGGER t_no_delete[\s\S]*RAISE\(ABORT, 'no'\);[\s\S]*END$/);
  });

  it("rejects an unterminated trigger", () => {
    expect(() => statements("CREATE TRIGGER x BEFORE DELETE ON t BEGIN SELECT 1;")).toThrow(/Unterminated CREATE TRIGGER/);
  });

  it("the simulator accepts a trigger and RAISE(ABORT) fires", async () => {
    for (const s of statements(
      "CREATE TABLE probe_t (x INTEGER);\nCREATE TRIGGER probe_t_nd BEFORE DELETE ON probe_t\nBEGIN\n  SELECT RAISE(ABORT, 'probe blocked');\nEND;\nINSERT INTO probe_t VALUES (1);"
    )) {
      await env.DB.prepare(s).run();
    }
    await expect(env.DB.prepare("DELETE FROM probe_t").run()).rejects.toThrow(/probe blocked/);
  });

  it("keeps a CASE...END expression inside a trigger body from ending the trigger early", async () => {
    const sql = [
      "CREATE TABLE case_t (x INTEGER);",
      "CREATE TRIGGER case_t_check BEFORE INSERT ON case_t",
      "BEGIN",
      "  SELECT CASE WHEN NEW.x > 1 THEN RAISE(ABORT, 'too big') END;",
      "END;",
    ].join("\n");
    const out = statements(sql);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(/^CREATE TRIGGER case_t_check[\s\S]*CASE WHEN NEW\.x > 1[\s\S]*END;[\s\S]*END$/);

    for (const s of out) {
      await env.DB.prepare(s).run();
    }
    await env.DB.prepare("INSERT INTO case_t (x) VALUES (0)").run();
    await expect(env.DB.prepare("INSERT INTO case_t (x) VALUES (2)").run()).rejects.toThrow(/too big/);
  });
});
