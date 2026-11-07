/** A crash inside text processing must end the job at once. Otherwise
 *  nothing writes the text KV and the assembler polls for it 20 times,
 *  60 s apart, before failing. */
import { describe, it, expect } from "vitest";
import worker, { failJobAfterCrash } from "./index";

function recordingDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            calls.push({ sql, args });
            return { success: true, meta: {} };
          },
        }),
      };
    },
  };
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
    const failed = db.calls.find((c) => /SET status = 'failed', stage = 'text'/.test(c.sql));
    expect(failed).toBeDefined();
    expect(failed!.sql).toMatch(/status NOT IN \('complete', 'failed'\)/);
    expect(String(failed!.args[0])).toContain("KV unavailable");
    expect(failed!.args[2]).toBe("job-crash-1");
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
