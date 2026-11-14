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
const PRODUCER_HEADER = /^\[\[(?:env\.[^.\]]+\.)?queues\.producers\]\]$/;

/** Drop a trailing `#` comment, ignoring any `#` inside a quoted string. */
function stripComment(line: string): string {
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quote = !quote;
    else if (line[i] === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

/** Every `queue = "..."` that sits under a table header matching `header`. */
function queuesUnder(toml: string, header: RegExp): string[] {
  const out: string[] = [];
  let inTable = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (line.startsWith("[")) {
      inTable = header.test(line);
      continue;
    }
    const m = inTable ? /^queue\s*=\s*"([^"]+)"/.exec(line) : null;
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** Every `queue = "..."` that sits under a consumer table header. */
export function consumedQueues(toml: string): string[] {
  return queuesUnder(toml, CONSUMER_HEADER);
}

/** Every `queue = "..."` that sits under a producer table header. */
export function producedQueues(toml: string): string[] {
  return queuesUnder(toml, PRODUCER_HEADER);
}

const declared = new Set([...Object.keys(QUEUE_AUDIT), ...Object.keys(PIPELINE_QUEUE_AUDIT)]);
const perConfig = Object.entries(configs).map(([path, toml]) => ({ path, queues: consumedQueues(toml) }));
const all = perConfig.flatMap((c) => c.queues);
const produced = new Set(Object.values(configs).flatMap((toml) => producedQueues(toml)));

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

  // A consumer whose queue nothing sends to is dead code that still holds
  // production bindings: if a message ever arrived (the queues REST API can
  // send one), it would run unreviewed. pivot-parlor-audit was one: it marked
  // shops and their sites active, and site-audit-queue had no producer.
  it("every queue a worker consumes has a producer in some worker's config", () => {
    const orphaned = perConfig.flatMap((c) => c.queues.filter((q) => !produced.has(q)).map((q) => `${c.path}: ${q}`));
    expect(orphaned).toEqual([]);
  });

  it("every declared pipeline queue is consumed by some worker's config", () => {
    expect(Object.keys(PIPELINE_QUEUE_AUDIT).filter((q) => !all.includes(q))).toEqual([]);
  });

  it("collects producer tables only, never consumer blocks", () => {
    const toml = [
      "[[queues.consumers]]",
      'queue = "consumed"',
      "[[queues.producers]]",
      'binding = "Q"',
      'queue = "produced" # comment',
      "[[env.staging.queues.producers]]",
      'queue = "produced-staging"',
      "[vars]",
      'queue = "not-a-queue"',
    ].join("\n");
    expect(producedQueues(toml)).toEqual(["produced", "produced-staging"]);
  });

  it("an exemption carries a reason", () => {
    for (const [queue, decl] of Object.entries({ ...QUEUE_AUDIT, ...PIPELINE_QUEUE_AUDIT })) {
      if (typeof decl === "object") expect(decl.exempt.trim().length, queue).toBeGreaterThan(0);
    }
  });
});
