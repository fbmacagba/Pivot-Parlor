import { expect, test } from "./fixtures";

// A browser extension that adds its own element to <body> before the page
// hydrates, as the owner's "Atlas Notepad" extension did (2026-11-14). React 18
// hydrates the whole document, so the extra element was a mismatch: it threw
// #418/#423, re-rendered the page on the client (destroying the extension's
// element) and sent a browser error report, which emails the owner. React 19
// skips unexpected elements in <head> and <body>. Measured under wrangler pages
// dev on 2026-11-15: React 18 had 23 to 29 hydration errors and 2 reports per
// page; React 19 had none. Load only: nothing is filled in or submitted.

const ELEMENT_ID = "e2e-extension-element";
// Init scripts run before <html> exists, so this watches the document itself.
const INJECT = `(() => {
  const add = () => {
    const el = document.createElement("div");
    el.id = ${JSON.stringify(ELEMENT_ID)};
    el.textContent = "an extension's panel";
    document.body.appendChild(el);
    window.__ppExtensionInjected = true;
  };
  if (document.body) add();
  else new MutationObserver((_, o) => { if (document.body) { o.disconnect(); add(); } }).observe(document, { childList: true, subtree: true });
})();`;

const HYDRATION = /#?4(18|23|25)\b|hydrat/i;

test.describe("A browser extension's element in the page", () => {
  for (const p of ["/", "/pricing", "/login"]) {
    test(`does not break hydration on ${p}`, async ({ page }) => {
      const errors: string[] = [];
      const reports: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error" && HYDRATION.test(m.text())) errors.push(m.text());
      });
      page.on("request", (req) => {
        if (req.method() === "POST" && new URL(req.url()).pathname === "/client-errors") reports.push(req.postData() ?? "");
      });
      await page.addInitScript(INJECT);

      await page.goto(p, { waitUntil: "load" });
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __reactRouterDataRouter?: unknown }).__reactRouterDataRouter))).toBe(true);
      // The stimulus ran: without this, a clean result could mean nothing was injected.
      expect(await page.evaluate(() => (window as unknown as { __ppExtensionInjected?: boolean }).__ppExtensionInjected === true)).toBe(true);
      await page.waitForTimeout(1500);

      expect(errors, "hydration errors").toEqual([]);
      expect(reports, "browser error reports").toEqual([]);
      expect(await page.locator(`#${ELEMENT_ID}`).count(), "the extension's element survives hydration").toBe(1);
    });
  }
});
