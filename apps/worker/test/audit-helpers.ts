/** Shared audit-trail test helpers (Plan 2). Every route task's test file
 *  reads its entries, gap rows and refusals through these. */
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { seedUser, tokenFor } from "./helpers";

/** Entries for one action, oldest first, optionally narrowed to a shop and/or entity. */
export async function entriesFor(filter: {
  action: string;
  shopId?: string;
  entityId?: string;
}): Promise<Record<string, unknown>[]> {
  const where = ["action = ?"];
  const binds: unknown[] = [filter.action];
  if (filter.shopId !== undefined) {
    where.push("shop_id = ?");
    binds.push(filter.shopId);
  }
  if (filter.entityId !== undefined) {
    where.push("entity_id = ?");
    binds.push(filter.entityId);
  }
  const r = await env.DB.prepare(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY occurred_at, rowid`)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return r.results ?? [];
}

/** How many audit.gap rows one request left (read its id from X-Request-Id). */
export async function gapRowsFor(requestId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.gap' AND request_id = ?")
    .bind(requestId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Run `fn` while no audit entry can be written: audit_log is renamed away and
 *  always restored, so a failing assertion inside cannot break later tests. */
export async function withAuditOff<T>(fn: () => Promise<T>): Promise<T> {
  await env.DB.prepare("ALTER TABLE audit_log RENAME TO audit_log_off").run();
  try {
    return await fn();
  } finally {
    await env.DB.prepare("ALTER TABLE audit_log_off RENAME TO audit_log").run();
  }
}

const HASHED_TEXT_COLUMNS = ["changes_json", "details_json", "reason", "entity_id"] as const;

/** Assert that none of the submitted personal or free-text `values` reached a
 *  hashed, 6-year column of `row`. A value is also looked for in its
 *  JSON-escaped form, since the JSON columns store it escaped. Empty strings
 *  are ignored (every column "contains" one). */
export function expectNoPersonalData(row: Record<string, unknown>, values: string[]): void {
  for (const value of values) {
    if (value === "") continue;
    const forms = [value, JSON.stringify(value).slice(1, -1)];
    for (const column of HASHED_TEXT_COLUMNS) {
      const cell = row[column];
      if (cell === null || cell === undefined) continue;
      const text = String(cell);
      for (const form of forms) {
        expect(text.includes(form), `${column} carries the submitted value ${JSON.stringify(value)}`).toBe(false);
      }
    }
  }
}

/** A developer user with a live session. */
export async function devToken(): Promise<{ id: string; token: string }> {
  const id = await seedUser("developer", null);
  return { id, token: await tokenFor(id, "developer", null) };
}

/** An admin user bound to `shopId`, with a live session. */
export async function adminToken(shopId: string): Promise<{ id: string; token: string }> {
  const id = await seedUser("admin", shopId);
  return { id, token: await tokenFor(id, "admin", shopId) };
}
