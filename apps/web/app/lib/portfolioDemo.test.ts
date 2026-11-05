import { describe, expect, it, vi } from "vitest";
import { getPortfolioDemoData, getPortfolioDemoSlots } from "./portfolioDemo";
import { isPortfolioDemoShop, PORTFOLIO_DEMO_SLUG } from "@repo/utils";
vi.mock("@remix-run/react", () => ({ Outlet: () => null }));
vi.mock("~/components/ErrorScreen", () => ({ ErrorScreen: () => null }));
vi.mock("~/components/CommercialShopChrome", () => ({
  CommercialShopChrome: () => null,
}));
vi.mock("~/components/ThemedBookingControls", () => ({
  ThemedButton: () => null,
  ThemedInput: () => null,
  ThemedTextarea: () => null,
  lightDark: {},
  platformFallbackVars: {},
}));
import { loader } from "~/routes/$shopSlug";
import {
  action as bookAction,
  loader as bookLoader,
} from "~/routes/$shopSlug.book";
import { action as waitlistAction } from "~/routes/$shopSlug.waitlist";

describe("portfolio demonstration", () => {
  it("refuses booking and waitlist form actions before parsing details or calling APIs", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No live API allowed"));
    try {
      for (const action of [bookAction, waitlistAction]) {
        const response = await action({
          params: { shopSlug: PORTFOLIO_DEMO_SLUG },
          context: { env: {} },
          request: new Request(
            `https://demo.test/${PORTFOLIO_DEMO_SLUG}/book`,
            { method: "POST" },
          ),
        } as never);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          success: false,
          error: expect.stringContaining("demonstration"),
        });
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("loads sample booking choices and availability without live APIs", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No live API allowed"));
    try {
      const response = await bookLoader({
        params: { shopSlug: PORTFOLIO_DEMO_SLUG },
        context: { env: {} },
        request: new Request(
          `https://demo.test/${PORTFOLIO_DEMO_SLUG}/book?date=2099-06-15&service_id=demo-classic`,
        ),
      } as never);
      const data = await response.json();
      expect(data.slots).toHaveLength(6);
      expect(data.deposit).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("recognizes only the exact server-owned demonstration slug", () => {
    expect(isPortfolioDemoShop(PORTFOLIO_DEMO_SLUG)).toBe(true);
    for (const candidate of [
      "",
      "another-shop",
      `${PORTFOLIO_DEMO_SLUG}-copy`,
      undefined,
    ]) {
      expect(isPortfolioDemoShop(candidate)).toBe(false);
    }
  });

  it("contains no reviews, ratings or personal contact details", () => {
    const data = getPortfolioDemoData();
    expect(data.reviews).toEqual([]);
    expect(data.settings.phone).toBeUndefined();
    expect(data.settings.address).toBeUndefined();
    expect(data.commercialServices.map((s) => s.name)).toEqual([
      "Classic haircut",
      "Clipper cut",
      "Restyle & finish",
    ]);
    expect(
      data.staff.every((s) => !/staff\s*\d|test/i.test(s.display_name)),
    ).toBe(true);
  });

  it("loads the demo without reading live shop APIs", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No live API allowed"));
    try {
      const response = await loader({
        params: { shopSlug: PORTFOLIO_DEMO_SLUG },
        context: { env: {} },
        request: new Request(`https://demo.test/${PORTFOLIO_DEMO_SLUG}`),
      } as never);
      expect(response.status).toBe(200);
      expect(fetch).not.toHaveBeenCalled();
      expect((await response.json()).slug).toBe(PORTFOLIO_DEMO_SLUG);
    } finally {
      fetch.mockRestore();
    }
  });

  it("returns only synthetic times for valid example selections", () => {
    const slots = getPortfolioDemoSlots("2099-06-15", "demo-classic", "any");
    expect(slots.length).toBeGreaterThan(0);
    expect(
      slots.every((s) => s.staff_id.startsWith("demo-") && s.is_available),
    ).toBe(true);
    expect(getPortfolioDemoSlots("2099-02-31", "demo-classic", "any")).toEqual(
      [],
    );
    expect(getPortfolioDemoSlots("2099-06-15", "real-service", "any")).toEqual(
      [],
    );
    expect(
      getPortfolioDemoSlots("2099-06-15", "demo-classic", "real-staff"),
    ).toEqual([]);
  });
});
