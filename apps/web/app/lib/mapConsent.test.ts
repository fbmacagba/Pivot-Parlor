import { describe, it, expect, afterEach, vi } from "vitest";
import { MAP_CONSENT_EVENT, SHOP_CONSENT_KEY, readMapConsent, recordShopConsent } from "./mapConsent";

// The shop cookie choice lives in one localStorage record. The Google map on
// a shop page loads only after the visitor allowed it there.
describe("map consent record", () => {
  afterEach(() => localStorage.clear());

  it("is undecided when nothing is stored", () => {
    expect(readMapConsent()).toBeNull();
  });

  it("is undecided for the old notice's record, which never asked about the map", () => {
    localStorage.setItem(SHOP_CONSENT_KEY, JSON.stringify({ essential: true, timestamp: "2026-07-01T00:00:00Z" }));
    expect(readMapConsent()).toBeNull();
  });

  it("is undecided when the record is not JSON", () => {
    localStorage.setItem(SHOP_CONSENT_KEY, "yes");
    expect(readMapConsent()).toBeNull();
  });

  it("reads back what was recorded", () => {
    recordShopConsent("granted");
    expect(readMapConsent()).toBe("granted");
    recordShopConsent("declined");
    expect(readMapConsent()).toBe("declined");
  });

  it("keeps essential cookies acknowledged and stamps the time", () => {
    recordShopConsent("declined");
    const stored = JSON.parse(localStorage.getItem(SHOP_CONSENT_KEY)!);
    expect(stored.essential).toBe(true);
    expect(typeof stored.timestamp).toBe("string");
  });

  it("keeps an earlier map choice when the plain notice is acknowledged", () => {
    recordShopConsent("granted");
    recordShopConsent(null);
    expect(readMapConsent()).toBe("granted");
  });

  it("tells mounted maps on this page about a new choice", () => {
    const heard = vi.fn();
    window.addEventListener(MAP_CONSENT_EVENT, heard);
    recordShopConsent("granted");
    window.removeEventListener(MAP_CONSENT_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
