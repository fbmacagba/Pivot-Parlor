import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { AUDIT_COLUMNS, createAuditRecorder, type AuditRunErrorResult } from "../src";

type Row = Record<(typeof AUDIT_COLUMNS)[number], unknown>;

/** Just enough D1 for run(): every audit_log INSERT a batch commits becomes a
 *  row. The actor below is "system" with no user and no IP, so the recorder
 *  never reads (no subject lookups). */
function fakeDb(): { db: D1Database; rows: Row[] } {
  const rows: Row[] = [];
  const db = {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => ({ sql, args }) };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      for (const s of stmts) {
        if (s.sql.startsWith("INSERT INTO audit_log")) {
          rows.push(Object.fromEntries(AUDIT_COLUMNS.map((c, i) => [c, s.args[i]])) as Row);
        }
      }
      return [];
    },
  };
  return { db: db as unknown as D1Database, rows };
}

function recorder() {
  const { db, rows } = fakeDb();
  const rec = createAuditRecorder({ db, worker: "test", via: "api", actor: { type: "system" }, requestId: "req-1" });
  return { rec, rows };
}

const INPUT = {
  action: "day.close" as const,
  shopId: "shop-in",
  entityType: "business_day",
  entityId: "bd-in",
  details: { keep: "x", holds_captured: 0 },
};

function outcomeRow(rows: Row[]): Row {
  expect(rows.map((r) => r.phase)).toEqual(["started", "outcome"]);
  return rows[1]!;
}

describe("run() describeError", () => {
  it("merges the hook's details over the input's on the failed outcome and rethrows the same error", async () => {
    const { rec, rows } = recorder();
    const err = new Error("boom: never stored");
    const hook = vi.fn((): AuditRunErrorResult => ({
      details: { holds_captured: 2, holds_failed: 1 },
      shopId: "shop-hook",
      entityType: "booking",
      entityId: "bk-hook",
    }));
    await expect(
      rec.run(INPUT, async () => {
        throw err;
      }, undefined, { describeError: hook })
    ).rejects.toBe(err);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(err);
    const out = outcomeRow(rows);
    expect(out).toMatchObject({
      outcome: "failed",
      reason: "Error",
      shop_id: "shop-hook",
      entity_type: "booking",
      entity_id: "bk-hook",
      changes_json: null,
      parent_id: rows[0]!.id,
    });
    expect(JSON.parse(out.details_json as string)).toEqual({ keep: "x", holds_captured: 2, holds_failed: 1 });
    expect(String(out.details_json)).not.toContain("boom");
  });

  it("never records changes, an outcome or a reason from the hook, even through a cast", async () => {
    const { rec, rows } = recorder();
    const smuggled = {
      details: { account_created: true },
      changes: { status: ["open", "closed"] },
      outcome: "succeeded",
      reason: "smuggled",
    } as unknown as AuditRunErrorResult;
    await expect(
      rec.run(INPUT, async () => {
        throw new TypeError("x");
      }, undefined, { describeError: () => smuggled })
    ).rejects.toThrow(TypeError);
    const out = outcomeRow(rows);
    // business_day.status is allow-listed, so a leaked change would survive the filter.
    expect(out).toMatchObject({ outcome: "failed", reason: "TypeError", changes_json: null });
    expect(JSON.parse(out.details_json as string)).toEqual({ keep: "x", holds_captured: 0, account_created: true });
  });

  it("ignores a hook that throws and records the outcome exactly as without one", async () => {
    const withHook = recorder();
    const without = recorder();
    const err = new RangeError("original");
    const body = async (): Promise<never> => {
      throw err;
    };
    await expect(
      withHook.rec.run(INPUT, body, undefined, {
        describeError: () => {
          throw new Error("hook broke");
        },
      })
    ).rejects.toBe(err);
    await expect(without.rec.run(INPUT, body)).rejects.toBe(err);
    const pick = (r: Row) => ({
      outcome: r.outcome,
      reason: r.reason,
      shop_id: r.shop_id,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      changes_json: r.changes_json,
      details_json: r.details_json,
    });
    expect(pick(outcomeRow(withHook.rows))).toEqual(pick(outcomeRow(without.rows)));
    expect(JSON.parse(outcomeRow(withHook.rows).details_json as string)).toEqual(INPUT.details);
  });

  it("without the hook a thrown body records the input's details, shop and entity", async () => {
    const { rec, rows } = recorder();
    await expect(
      rec.run(INPUT, async () => {
        throw new Error("x");
      })
    ).rejects.toThrow("x");
    expect(outcomeRow(rows)).toMatchObject({
      outcome: "failed",
      reason: "Error",
      shop_id: "shop-in",
      entity_type: "business_day",
      entity_id: "bd-in",
      details_json: JSON.stringify(INPUT.details),
    });
  });

  it("is not called when the body resolves", async () => {
    const { rec, rows } = recorder();
    const hook = vi.fn((): AuditRunErrorResult => ({ details: { never: true } }));
    expect(await rec.run(INPUT, async () => "ok", undefined, { describeError: hook })).toBe("ok");
    expect(hook).not.toHaveBeenCalled();
    expect(outcomeRow(rows)).toMatchObject({ outcome: "succeeded", details_json: JSON.stringify(INPUT.details) });
  });
});
