/**
 * WS-8: the assembler's schema check is assert-only. It must pass on a
 * database built from the canonical migration chain (which proves the chain,
 * not the worker, owns every column the assembler used to ALTER in at
 * runtime), and fail loudly, naming the gap, on one that missed a migration.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SchemaOutOfDateError, assertAssemblerSchema } from "../src/ensure-schema";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("assertAssemblerSchema", () => {
  it("passes on a database built from the canonical chain", async () => {
    await expect(assertAssemblerSchema(env.DB)).resolves.toBeUndefined();
  });

  it("names every missing column when a migration was skipped", async () => {
    await env.DB.prepare("ALTER TABLE shop_sites DROP COLUMN heading_weight").run();
    await env.DB.prepare("ALTER TABLE shop_sites DROP COLUMN seo_title").run();
    try {
      const err = await assertAssemblerSchema(env.DB).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(SchemaOutOfDateError);
      expect((err as Error).message).toMatch(/shop_sites\.seo_title/);
      expect((err as Error).message).toMatch(/shop_sites\.heading_weight/);
      expect((err as Error).message).not.toMatch(/[–—]/);
    } finally {
      await env.DB.prepare("ALTER TABLE shop_sites ADD COLUMN seo_title TEXT").run();
      await env.DB.prepare("ALTER TABLE shop_sites ADD COLUMN heading_weight TEXT").run();
    }
  });

  it("names a missing table outright", async () => {
    await env.DB.prepare("ALTER TABLE shop_sites RENAME TO shop_sites_gone").run();
    try {
      await expect(assertAssemblerSchema(env.DB)).rejects.toThrow(/shop_sites \(table\)/);
    } finally {
      await env.DB.prepare("ALTER TABLE shop_sites_gone RENAME TO shop_sites").run();
    }
  });

  it("passes a failing schema read through unchanged, so a D1 error is never reported as drift", async () => {
    const boom = new Error("D1_ERROR: network connection lost");
    const db = {
      prepare: () => ({
        all: async () => {
          throw boom;
        },
      }),
    } as unknown as D1Database;
    await expect(assertAssemblerSchema(db)).rejects.toBe(boom);
  });
});

describe("the assembler changes no schema", () => {
  it("no source file under src/ alters, creates or drops a table or index", () => {
    const files = Object.entries(sources).filter(([path]) => !path.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter(([, text]) => /\b(ALTER|CREATE|DROP)\s+(TABLE|INDEX)\b/i.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
