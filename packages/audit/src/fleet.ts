import type { AuditAction } from "./actions";

/** Queues consumed by the standalone pipeline workers (apps/workers/*), each
 *  declared with the action its consumer records, or a reasoned exemption.
 *  apps/worker/test/audit-queue-fleet.test.ts fails if a consumed queue is
 *  missing from here or from the API worker's own QUEUE_AUDIT. */
export const PIPELINE_QUEUE_AUDIT: Record<string, AuditAction | { exempt: string }> = {
  "site-research-queue": "ai.call",
  "site-text-queue": "ai.call",
  "site-images-queue": "ai.call",
  "site-assemble-queue": "site.regenerate.complete",
  "site-audit-queue": { exempt: "no producer; the audit worker is not deployed from this plan (Plan 4 Ruling 1)" },
};
