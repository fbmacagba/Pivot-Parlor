// The shops list's pure rules: where a shop is, filter and sort, the model
// badge, and reading the server's answer to "generate this shop's site".
import { describe, expect, it } from "vitest";
import { filterAndSortShops, modelBadgeVariant, readGenerateSiteReply, shopStage } from "./helpers";

const shop = (over: Record<string, unknown> = {}) => ({
  name: "Fade & Blade",
  slug: "fade-and-blade-001",
  owner_email: "owner@example.com",
  shop_number: 1,
  status: "active",
  has_site: 1 as number | null,
  website_status: "live" as string | null,
  created_at: "2026-01-01 10:00:00",
  ...over,
});

describe("shopStage", () => {
  it("puts an unpaid or not-yet-accepted shop before any site state", () => {
    expect(shopStage(shop({ status: "awaiting_payment" }))).toBe("awaiting_payment");
    expect(shopStage(shop({ status: "pending", stripe_payment_status: "unpaid" }))).toBe("awaiting_payment");
    expect(shopStage(shop({ status: "pending" }))).toBe("pending");
    expect(shopStage(shop({ status: "suspended" }))).toBe("suspended");
  });

  it("reads an active shop's site state, with no site and draft kept apart", () => {
    expect(shopStage(shop({ has_site: null, website_status: null }))).toBe("no_site");
    expect(shopStage(shop({ website_status: null }))).toBe("draft");
    expect(shopStage(shop({ website_status: "draft" }))).toBe("draft");
    expect(shopStage(shop({ website_status: "LIVE" }))).toBe("live");
    expect(shopStage(shop({ website_status: "paused" }))).toBe("paused");
  });
});

describe("filterAndSortShops", () => {
  const shops = [
    shop({ name: "Zed Cuts", slug: "zed-cuts-003", shop_number: 3, created_at: "2026-03-01 09:00:00" }),
    shop({
      name: "alpha Hair",
      slug: "alpha-hair-002",
      shop_number: 2,
      website_status: "paused",
      created_at: "2026-05-01 09:00:00",
    }),
    shop({
      name: "Mid Barbers",
      slug: "mid-001",
      shop_number: 1,
      owner_email: "sam@mid.test",
      has_site: null,
      created_at: "2026-02-01 09:00:00",
    }),
  ];
  const names = (list: Array<{ name: string }>) => list.map((s) => s.name);

  it("searches name, slug and owner email, ignoring case", () => {
    expect(names(filterAndSortShops(shops, { query: "ZED", stage: "", sort: "number" }))).toEqual(["Zed Cuts"]);
    expect(names(filterAndSortShops(shops, { query: "alpha-hair", stage: "", sort: "number" }))).toEqual(["alpha Hair"]);
    expect(names(filterAndSortShops(shops, { query: "sam@mid", stage: "", sort: "number" }))).toEqual(["Mid Barbers"]);
    expect(filterAndSortShops(shops, { query: "no such shop", stage: "", sort: "number" })).toEqual([]);
  });

  it("filters by stage, alone and together with the search", () => {
    expect(names(filterAndSortShops(shops, { query: "", stage: "paused", sort: "number" }))).toEqual(["alpha Hair"]);
    expect(names(filterAndSortShops(shops, { query: "", stage: "no_site", sort: "number" }))).toEqual(["Mid Barbers"]);
    expect(filterAndSortShops(shops, { query: "zed", stage: "paused", sort: "number" })).toEqual([]);
  });

  it("sorts by shop number, by name without regard to case, and newest first", () => {
    expect(names(filterAndSortShops(shops, { query: "", stage: "", sort: "number" }))).toEqual([
      "Mid Barbers",
      "alpha Hair",
      "Zed Cuts",
    ]);
    expect(names(filterAndSortShops(shops, { query: "", stage: "", sort: "name" }))).toEqual([
      "alpha Hair",
      "Mid Barbers",
      "Zed Cuts",
    ]);
    expect(names(filterAndSortShops(shops, { query: "", stage: "", sort: "newest" }))).toEqual([
      "alpha Hair",
      "Zed Cuts",
      "Mid Barbers",
    ]);
  });

  it("does not reorder the list it was given", () => {
    const before = names(shops);
    filterAndSortShops(shops, { query: "", stage: "", sort: "name" });
    expect(names(shops)).toEqual(before);
  });
});

describe("modelBadgeVariant", () => {
  it("gives Claude the Anthropic badge and Gemini the Google one", () => {
    expect(modelBadgeVariant("anthropic-api/claude-opus-5")).toBe("anthropic");
    expect(modelBadgeVariant("claude-sonnet")).toBe("anthropic");
    expect(modelBadgeVariant("google/gemini-4-flash")).toBe("google");
    expect(modelBadgeVariant("gemini-3.1-pro")).toBe("google");
  });

  it("never gives another vendor's model the Google blue", () => {
    for (const id of ["openai-api/gpt-6-astra", "z-ai/glm-5", "mistralai/mistral-large", "qwen/qwen-max"]) {
      expect(modelBadgeVariant(id)).toBe("outline");
    }
  });
});

describe("readGenerateSiteReply", () => {
  it("reads a started run's job id", () => {
    expect(readGenerateSiteReply(200, { success: true, data: { jobId: "job-1", message: "queued" } })).toEqual({
      jobId: "job-1",
      adopted: false,
    });
  });

  it("follows the run already going instead of reporting an error (409)", () => {
    expect(
      readGenerateSiteReply(409, {
        success: false,
        error: "A site generation is already running for this shop.",
        code: "generation_in_progress",
        data: { job_id: "job-running" },
      }),
    ).toEqual({ jobId: "job-running", adopted: true });
  });

  it("reports a 409 that names no job, and any other refusal, with its message", () => {
    expect(readGenerateSiteReply(409, { error: "API request failed", status: 409 })).toEqual({
      error: "API request failed",
    });
    expect(readGenerateSiteReply(400, { success: false, error: "Unknown text model: x" })).toEqual({
      error: "Unknown text model: x",
    });
    expect(readGenerateSiteReply(502, null)).toEqual({ error: "Could not start generation. Please try again." });
  });

  it("does not treat a job id on a refusal as a started run", () => {
    expect(readGenerateSiteReply(500, { data: { jobId: "job-x" } })).toHaveProperty("error");
  });
});
