import { describe, expect, it } from "vitest";
import { monthFromParams } from "./revenueMonth";

const NOW = new Date("2026-11-27T12:00:00Z");
const ask = (qs: string) => monthFromParams(new URLSearchParams(qs), NOW);

describe("monthFromParams", () => {
  it("shows this month when the address names none", () => {
    expect(ask("")).toEqual({ year: 2026, month: 11, adjusted: false });
  });

  it("honours a month the picker offers", () => {
    expect(ask("year=2026&month=3")).toEqual({ year: 2026, month: 3, adjusted: false });
    expect(ask("year=2025&month=01")).toEqual({ year: 2025, month: 1, adjusted: false });
    // 24 months, this one included: Dec 2024 is the oldest.
    expect(ask("year=2024&month=12")).toEqual({ year: 2024, month: 12, adjusted: false });
  });

  // Each of these used to reach the page as NaN and render "undefined NaN".
  it.each([
    "year=abc&month=3",
    "year=2026&month=xyz",
    "year=2026&month=13",
    "year=2026&month=0",
    "year=2026&month=-1",
    "year=2026&month=1.5",
    "year=2026",
    "month=5",
    "year=&month=",
    "year=20261&month=1",
  ])("falls back to this month, and says so, for %s", (qs) => {
    expect(ask(qs)).toEqual({ year: 2026, month: 11, adjusted: true });
  });

  it("falls back for a month still to come or older than the picker offers", () => {
    expect(ask("year=2026&month=12")).toEqual({ year: 2026, month: 11, adjusted: true });
    expect(ask("year=2024&month=11")).toEqual({ year: 2026, month: 11, adjusted: true });
  });
});
