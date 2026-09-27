import { describe, expect, it } from "vitest";
import { canonicalJson, chainHash, entryHash, GENESIS, sha256Hex } from "../src/canonical";
import type { AuditRow } from "../src/types";

const row: AuditRow = {
  id: "e1", occurred_at: "2026-09-26T10:00:00.000Z", seq: null, sealed_at: null, archived_at: null,
  archive_key: null, entry_hash: "", chain_hash: null, actor_type: "developer", actor_ref: "subj_user_u1",
  actor_role: "developer", via: "api", action: "site.pause", phase: "done", outcome: "succeeded",
  reason: null, shop_id: "s1", entity_type: "shop_site", entity_id: "s1",
  changes_json: '{"website_status":["live","paused"]}', details_json: null, request_id: "r1",
  parent_id: null, worker: "pivot-parlor-api", ip_ref: null, historical: 0,
};

describe("canonical hashing", () => {
  it("is independent of key order and ignores sealing columns", async () => {
    const reordered = Object.fromEntries(Object.entries(row).reverse()) as AuditRow;
    const sealed = { ...row, seq: 9, sealed_at: "x", chain_hash: "y", archived_at: "z", archive_key: "k", entry_hash: "q" };
    expect(canonicalJson(reordered)).toBe(canonicalJson(row));
    expect(await entryHash(sealed)).toBe(await entryHash(row));
  });

  it("changes when any hashed field changes", async () => {
    expect(await entryHash({ ...row, reason: "edited" })).not.toBe(await entryHash(row));
    expect(await entryHash({ ...row, actor_ref: "subj_user_u2" })).not.toBe(await entryHash(row));
  });

  it("chains from GENESIS with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await chainHash(GENESIS, "e")).toBe(await sha256Hex(`${GENESIS}e`));
  });
});
