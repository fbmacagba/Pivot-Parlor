import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The platform cookie bar on a first visit (components/PlatformCookieBanner.tsx).
 * Never pre-acknowledged here, unlike every other spec: this is the one place
 * a browser sees the bar the way a new visitor does.
 *
 * What only a real browser proves: the fixed controls along the bottom (the
 * floating sign-up button, Pip's launcher and teaser, Pip's message field)
 * really stand clear of the bar, no keyboard stop is hidden under it (WCAG 2.2
 * SC 2.4.11), and the install invitation waits for it. jsdom has no layout.
 */

test.use({ viewport: { width: 390, height: 844 } });

const bar = (page: Page) => page.getByRole("region", { name: "Cookie notice" });
// By its words: the promo strip's close button is also labelled "Dismiss".
const pipTeaser = (page: Page) => page.getByText("Got a shop? Let's talk");

/** Whether the centre of `selector`'s first match hits that element (nothing on top of it). */
async function reachable(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  }, selector);
}

/**
 * Tabs through the page and names every focused control that sits entirely
 * under the bar. Waits for each focus scroll to settle first: the site scrolls
 * smoothly, so a rectangle read straight after Tab is mid-flight.
 */
async function focusStopsHiddenUnderBar(page: Page, stops = 60): Promise<string[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const hidden: string[] = [];
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const under = await page.evaluate(async () => {
      await new Promise<void>((done) => {
        let last = window.scrollY;
        let still = 0;
        const tick = () => {
          if (window.scrollY === last) {
            if (++still >= 3) return done();
          } else {
            still = 0;
            last = window.scrollY;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const a = document.activeElement as HTMLElement | null;
      const b = document.querySelector('[aria-label="Cookie notice"]');
      if (!a || a === document.body || !b || b.contains(a)) return null;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const fully = ar.height > 0 && ar.top >= br.top && ar.bottom <= br.bottom;
      return fully ? (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 40) : null;
    });
    if (under && !hidden.includes(under)) hidden.push(under);
  }
  return hidden;
}

test.describe("cookie bar on a first visit", () => {
  test.setTimeout(60_000);

  test("every control along the bottom stays reachable while it shows", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(bar(page)).toBeVisible();
    // Past the moment Pip's teaser (4s) and the install invitation (1.5s)
    // would arrive: both wait for the bar instead.
    await page.waitForTimeout(5_000);
    await expect(pipTeaser(page)).toHaveCount(0);

    expect(await reachable(page, 'a[aria-label="Get your shop on Pivot"]')).toBe(true);
    expect(await reachable(page, 'button[aria-label="Chat with Pip"]')).toBe(true);

    expect(await focusStopsHiddenUnderBar(page)).toEqual([]);

    // One interruption at a time: the install invitation waits for the bar.
    await expect(page.getByRole("dialog", { name: /Get the .* app/ })).toHaveCount(0);
  });

  test("with text enlarged to 200% it stays under half the screen and hides nothing", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expect
      .poll(async () => (await bar(page).boundingBox())?.height ?? 0)
      .toBeGreaterThan(0);
    const box = await bar(page).boundingBox();
    expect(box!.height).toBeLessThanOrEqual(844 / 2);
    await expect(bar(page).getByRole("button", { name: "Got it" })).toBeInViewport();
    expect(await focusStopsHiddenUnderBar(page)).toEqual([]);
  });

  test("Got it closes it for good", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(bar(page)).toBeVisible();
    await bar(page).getByRole("button", { name: "Got it" }).click();
    await expect(bar(page)).toHaveCount(0);
    // The teaser that waited for the bar now follows it.
    await expect(pipTeaser(page)).toBeVisible({ timeout: 10_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    // Give the notice the moment it needs after hydration to (not) appear.
    await page.waitForTimeout(1500);
    await expect(bar(page)).toHaveCount(0);
  });

  test("Escape closes it, but closes Pip first when Pip is open", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(bar(page)).toBeVisible();
    await page.getByRole("button", { name: "Chat with Pip" }).click();
    const pip = page.locator("[data-pip-chat]");
    await expect(pip).toBeVisible();

    // Pip's message field sits above the bar, not under it (polled: the
    // panel slides up into place).
    const field = pip.getByRole("textbox", { name: "Message" });
    await expect
      .poll(async () => {
        const f = await field.boundingBox();
        const n = await bar(page).boundingBox();
        return f && n ? Math.round(n.y - (f.y + f.height)) : -1;
      })
      .toBeGreaterThanOrEqual(0);

    await page.keyboard.press("Escape");
    await expect(pip).toHaveCount(0);
    await expect(bar(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveCount(0);
  });

  test("shows on platform pages outside the marketing pages too", async ({ page }) => {
    await page.goto("/dpa", { waitUntil: "domcontentloaded" });
    await expect(bar(page)).toBeVisible();
  });
});
