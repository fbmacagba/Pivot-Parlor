/**
 * Schema assertion for the assembler (WS-8, assert-only).
 *
 * The assembler used to ALTER these shop_sites columns in at runtime, on every
 * message, to bridge a deploy that landed before its migration. Migrations
 * 021, 023, 040 and 042 own them, so this file only checks the shape and fails
 * loudly. The fix for a failure here is applying migrations
 * (node scripts/migrate.mjs --remote), never runtime DDL.
 *
 * shop_site_candidates is deliberately not listed: a missing candidate table
 * already fails the review path by name (migration 049).
 */
import type { D1Database } from "@cloudflare/workers-types";

/** The shop_sites columns the old runtime DDL used to add. */
export const SHOP_SITES_REQUIRED_COLUMNS: readonly string[] = [
  "seo_title",
  "seo_description",
  "trust_signals_json",
  "usps_json",
  "layout_mood",
  "brand_voice",
  "hero_cta",
  "about_title",
  "palette_json",
  "design_version",
  "heading_weight",
  "heading_style",
];

/** The database is missing a table or column the assembler needs. A failed
 *  read is NOT this error: it propagates unchanged, so a D1 outage is never
 *  reported as a missing migration. */
export class SchemaOutOfDateError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `assemble: the database is missing ${missing.join(", ")}. ` +
        "Apply the migrations (node scripts/migrate.mjs --remote); the assembler never changes the schema itself."
    );
    this.name = "SchemaOutOfDateError";
  }
}

/** One read. Throws SchemaOutOfDateError naming every gap. */
export async function assertAssemblerSchema(db: D1Database): Promise<void> {
  const { results } = await db.prepare("PRAGMA table_info(shop_sites)").all<{ name: string }>();
  const rows = results ?? [];
  if (rows.length === 0) throw new SchemaOutOfDateError(["shop_sites (table)"]);
  const have = new Set(rows.map((r) => r.name));
  const missing = SHOP_SITES_REQUIRED_COLUMNS.filter((c) => !have.has(c)).map((c) => `shop_sites.${c}`);
  if (missing.length > 0) throw new SchemaOutOfDateError(missing);
}
