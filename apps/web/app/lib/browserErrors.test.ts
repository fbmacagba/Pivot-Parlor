import { describe, expect, it } from "vitest";
import { browserFrames, describeBrowserError, MAX_FRAMES } from "./browserErrors";

// Browser errors reach the alert email only when the error ran through our
// own scripts (/assets/ on our origin). Extensions, Stripe, Turnstile and
// "Script error." never page the owner, and no page URL ever leaves the browser.

const ORIGIN = "https://pp.test";

const CHROME = [
  "TypeError: Cannot read properties of null (reading 'focus')",
  "    at onClick (https://pp.test/assets/contact-AbC123.js:1:2345)",
  "    at HTMLButtonElement.dispatch (https://pp.test/assets/entry.client-XyZ.js:9:87)",
].join("\n");

// Firefox and Safari write "name@url:line:col", with no "at ".
const FIREFOX = [
  "onClick@https://pp.test/assets/contact-AbC123.js:1:2345",
  "dispatch@https://pp.test/assets/entry.client-XyZ.js:9:87",
].join("\n");

const SAFARI = [
  "onClick@https://pp.test/assets/contact-AbC123.js:1:2345",
  "dispatchEvent@[native code]",
  "@https://pp.test/assets/entry.client-XyZ.js:9:87",
].join("\n");

function errorWith(stack: string | undefined, message = "Cannot read properties of null (reading 'focus')", name = "TypeError") {
  const error = new Error(message);
  error.name = name;
  Object.defineProperty(error, "stack", { value: stack, configurable: true });
  return error;
}

describe("browserFrames", () => {
  it("keeps our own script paths from a Chrome stack, without the origin", () => {
    expect(browserFrames(CHROME, ORIGIN)).toEqual([
      "at onClick (/assets/contact-AbC123.js:1:2345)",
      "at HTMLButtonElement.dispatch (/assets/entry.client-XyZ.js:9:87)",
    ]);
  });

  it("reads Firefox stacks", () => {
    expect(browserFrames(FIREFOX, ORIGIN)).toEqual([
      "onClick@/assets/contact-AbC123.js:1:2345",
      "dispatch@/assets/entry.client-XyZ.js:9:87",
    ]);
  });

  it("reads Safari stacks, skipping frames with no location", () => {
    expect(browserFrames(SAFARI, ORIGIN)).toEqual([
      "onClick@/assets/contact-AbC123.js:1:2345",
      "@/assets/entry.client-XyZ.js:9:87",
    ]);
  });

  it("replaces every other location, so the page URL and its query never leave the browser", () => {
    const stack = [
      "Error: boom",
      "    at https://pp.test/contact?email=jane@example.com&t=abc:12:5",
      "    at x (https://js.stripe.com/v3/assets/stripe.js:1:2)",
      "    at y (https://other.test/assets/contact-AbC123.js:1:2)",
      "    at onClick (https://pp.test/assets/contact-AbC123.js:1:2345)",
    ].join("\n");
    const frames = browserFrames(stack, ORIGIN);
    expect(frames).toEqual([
      "at <other>",
      "at x (<other>)",
      "at y (<other>)",
      "at onClick (/assets/contact-AbC123.js:1:2345)",
    ]);
    expect(frames?.join(" ")).not.toMatch(/jane|email|stripe|other\.test|pp\.test/);
  });

  it("drops the error when an extension is anywhere in the stack, in every browser's spelling", () => {
    const ours = "    at onClick (https://pp.test/assets/contact-AbC123.js:1:2345)";
    for (const foreign of [
      "    at e (chrome-extension://abcdefghijklmnop/content.js:1:2)",
      "e@moz-extension://1234-5678/content.js:1:2",
      "e@safari-web-extension://1234-5678/content.js:1:2",
      "e@webkit-masked-url://hidden/:1:2",
      "    at chrome-extension",
    ]) {
      expect(browserFrames(`TypeError: x\n${ours}\n${foreign}`, ORIGIN)).toBeNull();
    }
  });

  it("drops the error when none of the top frames is ours (Stripe, Turnstile)", () => {
    const stripe = "TypeError: x\n    at a (https://js.stripe.com/v3/stripe.js:1:2)\n    at b (https://js.stripe.com/v3/stripe.js:3:4)";
    expect(browserFrames(stripe, ORIGIN)).toBeNull();
    const deep = [
      "TypeError: x",
      ...Array.from({ length: MAX_FRAMES }, (_, i) => `    at f${i} (https://challenges.cloudflare.com/turnstile/v0/api.js:1:${i})`),
      "    at onClick (https://pp.test/assets/contact-AbC123.js:1:2345)",
    ].join("\n");
    expect(browserFrames(deep, ORIGIN)).toBeNull();
  });

  it("keeps at most the top frames", () => {
    const stack = Array.from({ length: 9 }, (_, i) => `    at f${i} (https://pp.test/assets/a-1.js:1:${i})`).join("\n");
    expect(browserFrames(stack, ORIGIN)).toHaveLength(MAX_FRAMES);
  });
});

describe("describeBrowserError", () => {
  it("describes an error from our own code", () => {
    expect(describeBrowserError(errorWith(CHROME), "script", ORIGIN, "routes/contact")).toEqual({
      kind: "script",
      route: "routes/contact",
      name: "TypeError",
      message: "Cannot read properties of null (reading 'focus')",
      frames: ["at onClick (/assets/contact-AbC123.js:1:2345)", "at HTMLButtonElement.dispatch (/assets/entry.client-XyZ.js:9:87)"],
    });
  });

  it("says unknown when the route is not known yet (an error before the app started)", () => {
    expect(describeBrowserError(errorWith(CHROME), "script", ORIGIN, undefined)?.route).toBe("unknown");
  });

  it("masks emails and ids in the message before it leaves the browser", () => {
    const message = "no booking for jane.doe@example.com id 3f2b9c1e-8a7d-4e5f-9b0c-1d2e3f4a5b6c";
    const out = describeBrowserError(errorWith(CHROME, message), "promise", ORIGIN, "root");
    expect(out?.message).toBe("no booking for <email> id <id>");
  });

  it("reports a DOM exception under one name, its own name kept in the message", () => {
    const error = new DOMException("Failed to execute 'removeChild' on 'Node'", "NotFoundError");
    Object.defineProperty(error, "stack", { value: CHROME, configurable: true });
    const out = describeBrowserError(error, "render", ORIGIN, "root");
    expect(out?.name).toBe("DOMException");
    expect(out?.message).toBe("NotFoundError: Failed to execute 'removeChild' on 'Node'");
  });

  it("ignores what is not an error with a stack (Script error., a thrown string, a rejected undefined)", () => {
    for (const bad of [null, undefined, "boom", 7, { message: "no stack" }, errorWith(undefined)]) {
      expect(describeBrowserError(bad, "script", ORIGIN, "root")).toBeNull();
    }
  });

  it("ignores aborted requests", () => {
    expect(describeBrowserError(errorWith(CHROME, "The user aborted a request.", "AbortError"), "promise", ORIGIN, "root")).toBeNull();
  });

  it("ignores a lost connection and a stale script after a deploy, in every browser's wording", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Network request failed",
      "Failed to fetch dynamically imported module: https://pp.test/assets/contact-AbC123.js",
      "Importing a module script failed.",
      "error loading dynamically imported module: https://pp.test/assets/contact-AbC123.js",
    ]) {
      expect(describeBrowserError(errorWith(CHROME, message), "render", ORIGIN, "root"), message).toBeNull();
    }
    // Control: the same stack with a real bug's message is reported.
    expect(describeBrowserError(errorWith(CHROME, "Failed to parse the price"), "render", ORIGIN, "root")).not.toBeNull();
  });
});
