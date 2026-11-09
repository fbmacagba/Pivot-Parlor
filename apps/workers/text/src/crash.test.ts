/** A crash inside text processing must end the job at once. Otherwise
 *  nothing writes the text KV and the assembler polls for it 20 times,
 *  60 s apart, before failing. */
import { describe, it, expect } from "vitest";
import { fakeAuditDb } from "@repo/audit/testing";
import worker, { failJobAfterCrash } from "./index";

/** A D1 stand-in that commits batches; `calls` is every non-audit statement. */
function recordingDb() {
  const fake = fakeAuditDb();
  return Object.assign(fake.db, { calls: fake.statements });
}

const message = { jobId: "job-crash-1", shopId: "shop-1", shopSlug: "shop-one" };

describe("text worker crash handling", () => {
  it("marks the job failed (stage text) when processing throws, and still acks", async () => {
    const db = recordingDb();
    const env = {
      DB: db,
      KV: {
        get: async () => {
          throw new Error("KV unavailable");
        },
      },
    };
    let acked = 0;
    await worker.queue(
      { messages: [{ body: message, ack: () => { acked++; } }] } as never,
      env as never
    );
    expect(acked).toBe(1);
    const failed = db.calls.find((c) => c.sql.startsWith("UPDATE generation_jobs SET status = ?"));
    expect(failed).toBeDefined();
    expect(failed!.sql).toMatch(/NOT IN \('complete', 'failed'\)/);
    expect(failed!.args[0]).toBe("failed");
    expect(failed!.args[1]).toBe("text");
    expect(String(failed!.args[2])).toContain("KV unavailable");
    expect(failed!.args[4]).toBe("job-crash-1");
  });

  it("does nothing for a message with no job id", async () => {
    const db = recordingDb();
    await failJobAfterCrash({ DB: db } as never, { shopId: "x" }, new Error("boom"));
    await failJobAfterCrash({ DB: db } as never, null, new Error("boom"));
    expect(db.calls).toEqual([]);
  });

  it("swallows a failure to record the failure (the message is still acked)", async () => {
    const env = {
      DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1 down"); } }) }) },
      KV: { get: async () => { throw new Error("KV unavailable"); } },
    };
    let acked = 0;
    await expect(
      worker.queue({ messages: [{ body: message, ack: () => { acked++; } }] } as never, env as never)
    ).resolves.toBeUndefined();
    expect(acked).toBe(1);
  });
});
