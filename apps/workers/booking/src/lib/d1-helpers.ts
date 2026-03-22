import type { D1Database } from "@cloudflare/workers-types";

export function d1Rows<T>(r: unknown): T[] {
  if (r && typeof r === "object" && "results" in r && Array.isArray((r as { results: T[] }).results)) {
    return (r as { results: T[] }).results;
  }
  return [];
}

export async function countWhere(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}
