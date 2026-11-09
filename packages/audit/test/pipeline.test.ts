import { describe, expect, it, vi } from "vitest";
import { AuditWriteError, createAuditRecorder } from "../src";
import {
  auditAiCall,
  completionEntryId,
  finishJob,
  finishJobStatements,
  originActorRef,
  queueAudit,
  type AiCallMeasure,
} from "../src/pipeline";
import { fakeAuditDb } from "../src/testing";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUARD = "COALESCE(status, 'queued') NOT IN ('complete', 'failed')";

const META = { purpose: "research", model: "openai-api/gpt-x", shopId: "shop-1", origin: "subj_user_abc-1" };
const MEASURE: AiCallMeasure = {
  model: "openai-api/gpt-x",
  route: "openai-api",
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.0123456789,
  costBasis: "table",
};

function recorderOver(fake: ReturnType<typeof fakeAuditDb>) {
  return createAuditRecorder({ db: fake.db, worker: "test", via: "queue", actor: { type: "system" }, requestId: "job-1" });
}

const JOB = {
  jobId: "job-1",
  shopId: "shop-1",
  status: "complete" as const,
  stage: "assemble",
  error: null,
  reason: null,
  origin: "subj_user_abc-1",
};

const details = (row: { details_json?: unknown }) => JSON.parse(row.details_json as string) as Record<string, unknown>;

describe("originActorRef", () => {
  it("keeps a user subject and drops anything else", () => {
    expect(originActorRef("subj_user_abc-1")).toBe("subj_user_abc-1");
    expect(originActorRef("subj_ip_x")).toBeNull();
    expect(originActorRef("subj_user_")).toBeNull();
    expect(originActorRef("alice@example.com")).toBeNull();
    expect(originActorRef(42)).toBeNull();
    expect(originActorRef(null)).toBeNull();
  });

  it("returns a valid value untouched and rejects padded or oversized ones", () => {
    const max = `subj_user_${"A".repeat(128)}`;
    expect(originActorRef(max)).toBe(max);
    expect(originActorRef(`${max}A`)).toBeNull();
    expect(originActorRef(" subj_user_abc")).toBeNull();
    expect(originActorRef("subj_user_abc\n")).toBeNull();
  });
});

describe("queueAudit", () => {
  it("records as a system actor via queue with the job id as request id", async () => {
    const fake = fakeAuditDb();
    await queueAudit(fake.db, "research", "job-9").write({ action: "ai.call", outcome: "succeeded" });
    expect(fake.rows[0]).toMatchObject({ actor_type: "system", via: "queue", request_id: "job-9", worker: "research" });
  });
});

describe("auditAiCall", () => {
  it("records started then a measured outcome", async () => {
    const fake = fakeAuditDb();
    const out = await auditAiCall(recorderOver(fake), META, async () => "reply", () => MEASURE);
    expect(out).toBe("reply");
    expect(fake.rows).toHaveLength(2);
    const [started, outcome] = fake.rows;
    expect(started).toMatchObject({ action: "ai.call", phase: "started", entity_type: "shop", entity_id: "shop-1", shop_id: "shop-1" });
    expect(details(started!)).toEqual({ purpose: "research", model: "openai-api/gpt-x", origin_actor_ref: "subj_user_abc-1" });
    expect(outcome).toMatchObject({ phase: "outcome", outcome: "succeeded", parent_id: started!.id });
    expect(details(outcome!)).toEqual({
      purpose: "research",
      model: "openai-api/gpt-x",
      route: "openai-api",
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost_usd: 0.012346,
      cost_basis: "table",
      origin_actor_ref: "subj_user_abc-1",
    });
  });

  it("never runs the call when the started write is refused", async () => {
    const fake = fakeAuditDb({ failAuditWrites: "started" });
    const call = vi.fn(async () => "reply");
    await expect(auditAiCall(recorderOver(fake), META, call, () => MEASURE)).rejects.toBeInstanceOf(AuditWriteError);
    expect(call).not.toHaveBeenCalled();
  });

  it("records a failed outcome and rethrows when the call throws", async () => {
    const fake = fakeAuditDb();
    const boom = Object.assign(new Error("secret provider body"), { name: "LlmError", status: 502 });
    await expect(
      auditAiCall(recorderOver(fake), META, async () => { throw boom; }, () => MEASURE)
    ).rejects.toBe(boom);
    const outcome = fake.rows[1]!;
    expect(outcome).toMatchObject({ phase: "outcome", outcome: "failed", reason: "LlmError (HTTP 502)" });
    expect(JSON.stringify(fake.rows)).not.toContain("secret provider body");
  });
});

describe("completionEntryId", () => {
  it("is stable per job and UUID-shaped", async () => {
    const a = await completionEntryId("job-1");
    expect(await completionEntryId("job-1")).toBe(a);
    const b = await completionEntryId("job-2");
    expect(b).not.toBe(a);
    expect(a).toMatch(UUID_SHAPE);
    expect(b).toMatch(UUID_SHAPE);
  });
});

describe("finishJobStatements", () => {
  it("puts the guarded job write before the entry", async () => {
    const fake = fakeAuditDb();
    const stmts = (await finishJobStatements(fake.db, recorderOver(fake), JOB)) as unknown as { sql: string; args: unknown[] }[];
    expect(stmts[0]!.sql).toContain(GUARD);
    expect(stmts[0]!.sql).toMatch(/^UPDATE generation_jobs SET status = \?, stage = \?, error = \?, updated_at = \? WHERE id = \?/);
    expect(stmts[0]!.args.slice(0, 3)).toEqual(["complete", "assemble", null]);
    expect(stmts[0]!.args[4]).toBe("job-1");
    await fake.db.batch(stmts as never);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]).toMatchObject({
      id: await completionEntryId("job-1"),
      action: "site.regenerate.complete",
      outcome: "succeeded",
      entity_type: "shop",
      shop_id: "shop-1",
    });
    expect(details(fake.rows[0]!)).toEqual({ job_id: "job-1", stage: "assemble", result: "complete", origin_actor_ref: "subj_user_abc-1" });
  });

  it("records a failed job as a failed outcome with the fixed reason code", async () => {
    const fake = fakeAuditDb();
    const stmts = await finishJobStatements(fake.db, recorderOver(fake), { ...JOB, status: "failed", reason: "no_valid_spec", error: "x" });
    await fake.db.batch(stmts);
    expect(fake.rows[0]).toMatchObject({ outcome: "failed", reason: "no_valid_spec" });
  });

  it("the completion entry never carries the job's error text", async () => {
    const fake = fakeAuditDb();
    const stmts = await finishJobStatements(fake.db, recorderOver(fake), {
      ...JOB,
      status: "failed",
      error: "model call failed: secret provider body",
      reason: "no_valid_spec",
    });
    await fake.db.batch(stmts);
    expect(fake.rows[0]!.reason).toBe("no_valid_spec");
    expect(JSON.stringify(fake.rows)).not.toContain("secret provider body");
    const update = (stmts[0] as unknown as { args: unknown[] }).args;
    expect(update).toContain("model call failed: secret provider body");
  });

  it("merges extra details into the entry", async () => {
    const fake = fakeAuditDb();
    const stmts = await finishJobStatements(fake.db, recorderOver(fake), { ...JOB, details: { warnings: 2 } });
    await fake.db.batch(stmts);
    expect(details(fake.rows[0]!)).toMatchObject({ job_id: "job-1", warnings: 2 });
  });
});

describe("finishJob", () => {
  it("commits the job write and the entry in one batch", async () => {
    const fake = fakeAuditDb();
    expect(await finishJob(fake.db, recorderOver(fake), JOB)).toBe("finished");
    expect(fake.rows).toHaveLength(1);
    expect(fake.statements).toHaveLength(1);
  });

  it("reports already_finished when the completion entry already exists and the job is terminal", async () => {
    const fake = fakeAuditDb({ answer: (sql) => (/FROM generation_jobs/.test(sql) ? { status: "complete" } : null) });
    expect(await finishJob(fake.db, recorderOver(fake), JOB)).toBe("finished");
    expect(await finishJob(fake.db, recorderOver(fake), JOB)).toBe("already_finished");
    expect(fake.rows.filter((r) => r.action === "site.regenerate.complete")).toHaveLength(1);
  });

  it("rethrows when the batch fails and the job is not terminal", async () => {
    const fake = fakeAuditDb({ answer: (sql) => (/FROM generation_jobs/.test(sql) ? { status: "running" } : null) });
    await finishJob(fake.db, recorderOver(fake), JOB);
    await expect(finishJob(fake.db, recorderOver(fake), JOB)).rejects.toThrow();
  });

  it("runs extra statements in the same batch", async () => {
    const fake = fakeAuditDb();
    const extra = [fake.db.prepare("UPDATE shops SET x = ?").bind(1)];
    await finishJob(fake.db, recorderOver(fake), JOB, extra);
    expect(fake.statements.map((s) => s.sql.split(" ")[1])).toEqual(["shops", "generation_jobs"]);

    const failing = fakeAuditDb({ failAuditWrites: "all" });
    const extra2 = [failing.db.prepare("UPDATE shops SET x = ?").bind(1)];
    await expect(finishJob(failing.db, recorderOver(failing), JOB, extra2)).rejects.toThrow();
    expect(failing.statements).toEqual([]);
    expect(failing.rows).toEqual([]);
  });
});
