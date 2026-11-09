import { describe, expect, it } from "vitest";
import { PIPELINE_QUEUE_AUDIT } from "@repo/audit";
import { QUEUE_AUDIT } from "../src/audit/registry";

const own = import.meta.glob("../wrangler.toml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const pipeline = import.meta.glob("../../workers/*/wrangler.toml", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
const configs: Record<string, string> = { ...own, ...pipeline };

const CONSUMER_HEADER = /^\[\[(?:env\.[^.\]]+\.)?queues\.consumers\]\]$/;

/** Drop a trailing `#` comment, ignoring any `#` inside a quoted string. */
function stripComment(line: string): string {
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quote = !quote;
    else if (line[i] === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

/** Every `queue = "..."` that sits under a consumer table header. */
export function consumedQueues(toml: string): string[] {
  const out: string[] = [];
  let inConsumer = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line.startsWith("[")) {
      inConsumer = CONSUMER_HEADER.test(line);
      continue;
    }
    const m = inConsumer ? /^queue\s*=\s*"([^"]+)"/.exec(line) : null;
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

const declared = new Set([...Object.keys(QUEUE_AUDIT), ...Object.keys(PIPELINE_QUEUE_AUDIT)]);
const perConfig = Object.entries(configs).map(([path, toml]) => ({ path, queues: consumedQueues(toml) }));
const all = perConfig.flatMap((c) => c.queues);

describe("audit queue fleet coverage", () => {
  it("every queue a worker consumes is declared", () => {
    const undeclared = perConfig.flatMap((c) => c.queues.filter((q) => !declared.has(q)).map((q) => `${c.path}: ${q}`));
    expect(undeclared).toEqual([]);
  });

  it("reads the files it claims to check", () => {
    expect(Object.keys(configs).length).toBeGreaterThanOrEqual(7);
    expect(all).toContain("site-assemble-queue");
    expect(all).toContain("pivot-parlor-reminders");
  });

  it("collects consumer tables only, never producer blocks", () => {
    const toml = [
      "[[queues.producers]]",
      'queue = "producer-only" # comment',
      "[[env.staging.queues.producers]]",
      'queue = "producer-staging"',
      "[[queues.consumers]]",
      'queue = "consumed" # "quoted"',
      "[[env.staging.queues.consumers]]",
      'queue = "consumed-staging"',
      "[vars]",
      'queue = "not-a-queue"',
    ].join("\n");
    expect(consumedQueues(toml)).toEqual(["consumed", "consumed-staging"]);
    // each pipeline queue is consumed by exactly one config
    expect(all.filter((q) => q === "site-assemble-queue")).toHaveLength(1);
    expect(all.filter((q) => q === "site-research-queue")).toHaveLength(1);
  });

  it("an exemption carries a reason", () => {
    for (const [queue, decl] of Object.entries({ ...QUEUE_AUDIT, ...PIPELINE_QUEUE_AUDIT })) {
      if (typeof decl === "object") expect(decl.exempt.trim().length, queue).toBeGreaterThan(0);
    }
  });
});
