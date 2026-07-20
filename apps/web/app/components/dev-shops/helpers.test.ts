import { describe, it, expect } from "vitest";
import {
  buildRegeneratePayload,
  decidePollAction,
  isTerminalJobState,
  regenJobStepStates,
  POLL_RESEARCH_STALL_MS,
  POLL_OVERALL_MAX_MS,
  POLL_MAX_CONSECUTIVE_FAILURES,
} from "./helpers";

describe("isTerminalJobState", () => {
  it("is true once the job reaches a terminal status or stage", () => {
    expect(isTerminalJobState("complete", "complete")).toBe(true);
    expect(isTerminalJobState("failed", "research")).toBe(true);
    expect(isTerminalJobState("running", "complete")).toBe(true);
    expect(isTerminalJobState("running", "done")).toBe(true);
    expect(isTerminalJobState("COMPLETE", "")).toBe(true);
  });

  it("is false while the job is still in flight", () => {
    expect(isTerminalJobState("running", "research")).toBe(false);
    expect(isTerminalJobState("running", "parallel")).toBe(false);
    expect(isTerminalJobState("queued", "research")).toBe(false);
    expect(isTerminalJobState("", "")).toBe(false);
  });

  it("agrees with the progress UI's terminal steps (no in-flight step is terminal)", () => {
    // Every status/stage pair the poller treats as terminal must render a
    // finished (all-done or failed) progress column, and vice versa.
    const pairs: [string, string][] = [
      ["running", "research"],
      ["running", "parallel"],
      ["running", "assemble"],
      ["complete", "complete"],
      ["failed", "research"],
      ["failed", "assemble"],
    ];
    for (const [status, stage] of pairs) {
      const steps = regenJobStepStates(status, stage);
      const uiTerminal = steps.every((s) => s === "done") || steps.some((s) => s === "failed");
      expect(isTerminalJobState(status, stage)).toBe(uiTerminal);
    }
  });
});

describe("buildRegeneratePayload", () => {
  it("includes images when requested (skip_images false) and skips them otherwise", () => {
    expect(buildRegeneratePayload({ includeImages: true }).skip_images).toBe(false);
    expect(buildRegeneratePayload({ includeImages: false }).skip_images).toBe(true);
  });

  it("adds a chosen palette as color_primary/accent", () => {
    const body = buildRegeneratePayload({
      includeImages: true,
      palette: { primary: "#0F0F10", accent: "#C9A24B" },
    });
    expect(body).toEqual({ skip_images: false, color_primary: "#0F0F10", color_accent: "#C9A24B" });
  });

  it("omits colours when the palette is auto (null/absent)", () => {
    expect(buildRegeneratePayload({ includeImages: false, palette: null })).toEqual({ skip_images: true });
    expect(buildRegeneratePayload({ includeImages: true })).toEqual({ skip_images: false });
  });
});

describe("decidePollAction", () => {
  const base = { elapsedMs: 1_000, consecutiveFailures: 0 };

  it("stops on a terminal state", () => {
    expect(decidePollAction({ ...base, ok: true, status: "complete", stage: "complete" })).toEqual({
      kind: "terminal",
    });
    expect(decidePollAction({ ...base, ok: true, status: "failed", stage: "research" })).toEqual({
      kind: "terminal",
    });
  });

  it("keeps polling a healthy in-flight job", () => {
    expect(decidePollAction({ ...base, ok: true, status: "running", stage: "research" })).toEqual({
      kind: "update",
    });
    expect(decidePollAction({ ...base, ok: true, status: "running", stage: "parallel" })).toEqual({
      kind: "update",
    });
  });

  it("flags a job still in research past the research deadline as stalled", () => {
    const d = decidePollAction({
      ok: true,
      status: "queued",
      stage: "research",
      elapsedMs: POLL_RESEARCH_STALL_MS,
      consecutiveFailures: 0,
    });
    expect(d.kind).toBe("stalled");
    expect(d).toHaveProperty("message");
  });

  it("still allows a long assemble wait (past the research deadline, before the overall cap)", () => {
    // Slow image models legitimately keep the assembler waiting many minutes;
    // a job that has advanced past research must not be cut off early.
    expect(
      decidePollAction({
        ok: true,
        status: "running",
        stage: "assemble",
        elapsedMs: POLL_RESEARCH_STALL_MS + 60_000,
        consecutiveFailures: 0,
      }),
    ).toEqual({ kind: "update" });
  });

  it("stalls on any stage once the overall cap is reached", () => {
    const d = decidePollAction({
      ok: true,
      status: "running",
      stage: "assemble",
      elapsedMs: POLL_OVERALL_MAX_MS,
      consecutiveFailures: 0,
    });
    expect(d.kind).toBe("stalled");
  });

  it("keeps polling through a few transient endpoint failures", () => {
    expect(
      decidePollAction({ ...base, ok: false, status: "", stage: "", consecutiveFailures: 3 }),
    ).toEqual({ kind: "keep-going" });
  });

  it("gives up after too many consecutive endpoint failures", () => {
    const d = decidePollAction({
      ok: false,
      status: "",
      stage: "",
      elapsedMs: 30_000,
      consecutiveFailures: POLL_MAX_CONSECUTIVE_FAILURES,
    });
    expect(d.kind).toBe("give-up");
    expect(d).toHaveProperty("message");
  });

  it("reproduces the orphaned-research freeze: a never-terminal queued/research response resolves to stalled, never an endless update", () => {
    // Real prod repro: GET /api/jobs/:id/status returns
    // {success:true, status:"queued", stage:"research"} indefinitely for a job
    // the pipeline orphaned. Before the fix the poller looped on {kind:"update"}
    // forever (the 1026-hit runaway, bar frozen on "Researching brand & style").
    const d = decidePollAction({
      ok: true,
      status: "queued",
      stage: "research",
      elapsedMs: 6 * 60_000,
      consecutiveFailures: 0,
    });
    expect(d.kind).toBe("stalled");
  });
});

describe("regenJobStepStates fallback", () => {
  it("shows the research step active while researching", () => {
    expect(regenJobStepStates("running", "research")[0]).toBe("active");
  });

  it("marks every step done on completion", () => {
    expect(regenJobStepStates("complete", "complete").every((s) => s === "done")).toBe(true);
  });

  it("falls back to an active research step for an empty/unknown poll", () => {
    // This is the optimistic state the runaway poller could get pinned to; the
    // fix stops polling on a terminal state so this fallback cannot persist
    // past completion.
    expect(regenJobStepStates("", "")[0]).toBe("active");
  });
});
