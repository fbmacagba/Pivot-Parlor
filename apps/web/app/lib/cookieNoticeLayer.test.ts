/** cookieNoticeLayer: the page-wide record of a cookie notice on screen. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("./cookieNoticeLayer");
}

function heightVar(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

describe("cookieNoticeLayer", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.cookieNotice;
  });
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.cookieNotice;
  });

  it("publishes the open notice's height on <html> and clears it on close", async () => {
    const m = await load();
    expect(m.isCookieNoticeOpen()).toBe(false);

    m.publishCookieNotice("platform", 183.4);
    expect(m.isCookieNoticeOpen()).toBe(true);
    expect(heightVar(m.COOKIE_NOTICE_HEIGHT_VAR)).toBe("184px");
    expect(document.documentElement.dataset.cookieNotice).toBe("open");

    m.publishCookieNotice("platform", null);
    expect(m.isCookieNoticeOpen()).toBe(false);
    expect(heightVar(m.COOKIE_NOTICE_HEIGHT_VAR)).toBe("");
    expect(document.documentElement.dataset.cookieNotice).toBeUndefined();
  });

  it("one notice closing never clears the other's entry", async () => {
    const m = await load();
    m.publishCookieNotice("platform", 120);
    m.publishCookieNotice("shop", 80);
    expect(heightVar(m.COOKIE_NOTICE_HEIGHT_VAR)).toBe("120px");

    // A client-side move from a platform page to a shop page unmounts the
    // platform notice after the shop's has already published.
    m.publishCookieNotice("platform", null);
    expect(m.isCookieNoticeOpen()).toBe(true);
    expect(heightVar(m.COOKIE_NOTICE_HEIGHT_VAR)).toBe("80px");

    m.publishCookieNotice("shop", null);
    expect(m.isCookieNoticeOpen()).toBe(false);
    expect(heightVar(m.COOKIE_NOTICE_HEIGHT_VAR)).toBe("");
  });

  it("announces opening and closing once each, not every height change", async () => {
    const m = await load();
    const seen = vi.fn();
    window.addEventListener(m.COOKIE_NOTICE_EVENT, seen);
    try {
      m.publishCookieNotice("platform", 100);
      m.publishCookieNotice("platform", 140);
      m.publishCookieNotice("shop", 90);
      expect(seen).toHaveBeenCalledTimes(1);

      m.publishCookieNotice("platform", null);
      expect(seen).toHaveBeenCalledTimes(1);
      m.publishCookieNotice("shop", null);
      expect(seen).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(m.COOKIE_NOTICE_EVENT, seen);
    }
  });

  it("closing a notice that never opened announces nothing", async () => {
    const m = await load();
    const seen = vi.fn();
    window.addEventListener(m.COOKIE_NOTICE_EVENT, seen);
    try {
      m.publishCookieNotice("shop", null);
      expect(seen).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(m.COOKIE_NOTICE_EVENT, seen);
    }
  });

  it("every lift class reads the same variable, falling back to 0px", async () => {
    const m = await load();
    const offsets = Object.values(m.ABOVE_COOKIE_NOTICE);
    expect(offsets.length).toBeGreaterThan(0);
    for (const cls of offsets) {
      expect(cls).toContain(`var(${m.COOKIE_NOTICE_HEIGHT_VAR},0px)`);
    }
  });
});
