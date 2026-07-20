import { describe, it, expect } from "vitest";
import { buildRegeneratePayload, isTerminalJobState, regenJobStepStates } from "./helpers";

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
