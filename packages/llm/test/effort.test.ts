import { describe, it, expect } from "vitest";
import { EFFORT_LEVELS, chatComplete, orderEfforts, outputBudgetForEffort, parseEffort } from "../src/index";
import { anthropicEffort } from "../src/adapters/anthropic";

describe("effort ladder", () => {
  it("runs none to max", () => {
    expect([...EFFORT_LEVELS]).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("parses known levels only", () => {
    expect(parseEffort("xhigh")).toBe("xhigh");
    expect(parseEffort("none")).toBe("none");
    expect(parseEffort("")).toBeUndefined();
    expect(parseEffort("HIGH")).toBeUndefined();
    expect(parseEffort("ultra")).toBeUndefined();
    expect(parseEffort(3)).toBeUndefined();
  });

  it("orders a vendor's list by the ladder and drops strangers", () => {
    expect(orderEfforts(["max", "xhigh", "high", "medium", "low", "none"])).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(orderEfforts(["high", "turbo", "high"])).toEqual(["high"]);
    expect(orderEfforts([])).toEqual([]);
  });

  it("gives xhigh and max room to reason and finish, and leaves the rest at the caller's base", () => {
    expect(outputBudgetForEffort(undefined, 8000)).toBe(8000);
    expect(outputBudgetForEffort("high", 8000)).toBe(8000);
    expect(outputBudgetForEffort("xhigh", 8000)).toBe(12_288);
    expect(outputBudgetForEffort("max", 8000)).toBe(16_000);
    expect(outputBudgetForEffort("max", 20_000)).toBe(20_000);
  });
});

describe("Anthropic effort mapping", () => {
  it("passes low to max through and lifts none and minimal to low", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) expect(anthropicEffort(level)).toBe(level);
    expect(anthropicEffort("none")).toBe("low");
    expect(anthropicEffort("minimal")).toBe("low");
  });

  it("sends xhigh as output_config.effort", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch;
    await chatComplete(
      { modelId: "anthropic-api/claude-opus-5-5", messages: [{ role: "user", content: "hi" }], effort: "xhigh", maxTokens: 100 },
      { anthropic: "an-key" },
      { fetch: fetchImpl },
    );
    expect(bodies[0]?.output_config).toEqual({ effort: "xhigh" });
  });
});
