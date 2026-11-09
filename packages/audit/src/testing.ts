import type { D1Database } from "@cloudflare/workers-types";
import { AUDIT_COLUMNS } from "./types";

/** An audit_log row as the recorder wrote it, keyed by column name. */
export type AuditRowRecord = Record<(typeof AUDIT_COLUMNS)[number], unknown>;

export interface FakeAuditDbOptions {
  /** Make any batch holding an audit_log INSERT of this phase throw. */
  failAuditWrites?: "started" | "outcome" | "all";
  /** Make any statement whose SQL matches throw (a batch holding it throws). */
  failOnSql?: RegExp;
  /** What first() resolves for a query. Without it first() resolves null. */
  answer?: (sql: string, args: unknown[]) => unknown;
}

export interface FakeAuditDb {
  db: D1Database;
  /** Every audit_log INSERT that committed, in commit order. */
  rows: AuditRowRecord[];
  /** Every other committed statement, in commit order. */
  statements: { sql: string; args: unknown[] }[];
}

interface Stmt {
  sql: string;
  args: unknown[];
}

const AUDIT_INSERT = "INSERT INTO audit_log";
const ID_INDEX = AUDIT_COLUMNS.indexOf("id");
const PHASE_INDEX = AUDIT_COLUMNS.indexOf("phase");

/**
 * Just enough D1 for tests that exercise audit recording. A batch is atomic:
 * if any statement fails (failAuditWrites, failOnSql, or an audit_log id that
 * already committed, as D1's primary key would refuse), nothing from that
 * batch is recorded.
 */
export function fakeAuditDb(opts: FakeAuditDbOptions = {}): FakeAuditDb {
  const rows: AuditRowRecord[] = [];
  const statements: Stmt[] = [];
  const ids = new Set<unknown>();

  const isAudit = (s: Stmt) => s.sql.startsWith(AUDIT_INSERT);
  const failsSql = (s: Stmt) => opts.failOnSql?.test(s.sql) ?? false;

  const make = (sql: string, args: unknown[]) => {
    const stmt: Stmt & { first(): Promise<unknown>; run(): Promise<unknown>; bind(...a: unknown[]): unknown } = {
      sql,
      args,
      bind: (...a: unknown[]) => make(sql, a),
      async first() {
        return opts.answer ? opts.answer(sql, args) : null;
      },
      async run() {
        if (failsSql(stmt)) throw new Error(`fakeAuditDb: failOnSql matched: ${sql}`);
        if (isAudit(stmt)) commit([stmt]);
        else statements.push({ sql, args });
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  };

  function commit(batch: Stmt[]): void {
    const pending = new Set<unknown>();
    for (const s of batch) {
      if (failsSql(s)) throw new Error(`fakeAuditDb: failOnSql matched: ${s.sql}`);
      if (!isAudit(s)) continue;
      const phase = s.args[PHASE_INDEX];
      const mode = opts.failAuditWrites;
      if (mode && (mode === "all" || mode === phase)) throw new Error(`fakeAuditDb: audit write refused (${String(phase)})`);
      const id = s.args[ID_INDEX];
      if (ids.has(id) || pending.has(id)) throw new Error("UNIQUE constraint failed: audit_log.id");
      pending.add(id);
    }
    for (const s of batch) {
      if (isAudit(s)) {
        rows.push(Object.fromEntries(AUDIT_COLUMNS.map((c, i) => [c, s.args[i]])) as AuditRowRecord);
        ids.add(s.args[ID_INDEX]);
      } else {
        statements.push({ sql: s.sql, args: s.args });
      }
    }
  }

  const db = {
    prepare: (sql: string) => make(sql, []),
    async batch(batch: Stmt[]) {
      commit(batch);
      return batch.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { db: db as unknown as D1Database, rows, statements };
}
