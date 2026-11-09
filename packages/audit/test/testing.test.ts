import { describe, expect, it } from "vitest";
import { AuditWriteError, createAuditRecorder } from "../src";
import { fakeAuditDb } from "../src/testing";

const INPUT = {
  action: "day.close" as const,
  shopId: "shop-1",
  entityType: "business_day",
  entityId: "bd-1",
};

function recorderOver(fake: ReturnType<typeof fakeAuditDb>, actor: Parameters<typeof createAuditRecorder>[0]["actor"] = { type: "system" }) {
  return createAuditRecorder({ db: fake.db, worker: "test", via: "cron", actor, requestId: "req-1" });
}

describe("fakeAuditDb", () => {
  it("records a system entry written through the recorder", async () => {
    const fake = fakeAuditDb();
    await recorderOver(fake).write({ ...INPUT, phase: "single", outcome: "succeeded" });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.action).toBe("day.close");
  });

  it("failAuditWrites: started refuses the started row and nothing else", async () => {
    const fake = fakeAuditDb({ failAuditWrites: "started" });
    const fn = async () => "ran";
    await expect(recorderOver(fake).run(INPUT, fn)).rejects.toBeInstanceOf(AuditWriteError);
    expect(fake.rows).toEqual([]);
  });

  it("failAuditWrites: outcome lets the started row commit and refuses the outcome", async () => {
    const fake = fakeAuditDb({ failAuditWrites: "outcome" });
    const result = await recorderOver(fake).run(INPUT, async () => "ran");
    expect(result).toBe("ran");
    expect(fake.rows.map((r) => r.phase)).toEqual(["started"]);
  });

  it("answers first() with null so an IP actor gets a fresh subject", async () => {
    const fake = fakeAuditDb();
    await recorderOver(fake, { type: "anonymous", ip: "203.0.113.9" }).write({ ...INPUT, phase: "single", outcome: "succeeded" });
    expect(String(fake.rows[0]!.ip_ref)).toMatch(/^subj_ip_/);
  });

  it("first() answers through the answer hook", async () => {
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const fake = fakeAuditDb({
      answer: (sql, args) => {
        seen.push({ sql, args });
        return { id: "subj_ip_existing" };
      },
    });
    await recorderOver(fake, { type: "anonymous", ip: "203.0.113.9" }).write({ ...INPUT, phase: "single", outcome: "succeeded" });
    expect(fake.rows[0]!.ip_ref).toBe("subj_ip_existing");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain("audit_subjects");
    expect(seen[0]!.args).toContain("203.0.113.9");
  });

  it("failOnSql makes a matching batch throw and commits none of its statements", async () => {
    const fake = fakeAuditDb({ failOnSql: /UPDATE bookings/ });
    const change = fake.db.prepare("UPDATE bookings SET status = ? WHERE id = ?").bind("done", "bk-1");
    await expect(recorderOver(fake).batch([change], { ...INPUT, phase: "single", outcome: "succeeded" })).rejects.toThrow();
    expect(fake.rows).toEqual([]);
    expect(fake.statements).toEqual([]);
  });

  it("records non-audit statements in commit order", async () => {
    const fake = fakeAuditDb();
    const change = fake.db.prepare("UPDATE bookings SET status = ? WHERE id = ?").bind("done", "bk-1");
    await recorderOver(fake).batch([change], { ...INPUT, phase: "single", outcome: "succeeded" });
    expect(fake.statements[0]).toEqual({ sql: "UPDATE bookings SET status = ? WHERE id = ?", args: ["done", "bk-1"] });
    expect(fake.rows).toHaveLength(1);
  });

  it("rejects a second entry with the same id, committing nothing from that batch", async () => {
    const fake = fakeAuditDb();
    const rec = recorderOver(fake);
    const id = await rec.write({ ...INPUT, phase: "single", outcome: "succeeded" });
    const before = fake.statements.length;
    const change = fake.db.prepare("UPDATE bookings SET status = ? WHERE id = ?").bind("done", "bk-1");
    const dup = (await rec.statements({ ...INPUT, id, phase: "single", outcome: "succeeded" }))[0]!;
    await expect(fake.db.batch([change, dup])).rejects.toThrow(/UNIQUE|PRIMARY/i);
    expect(fake.rows).toHaveLength(1);
    expect(fake.statements).toHaveLength(before);
  });
});
