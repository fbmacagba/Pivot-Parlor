// @vitest-environment node
/** entry.server.tsx aborts a render that outlives streamTimeout, with a timer
 *  and a listener on the visitor's request. Both must go once the render is
 *  over, including when the render fails before it streams anything. */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-dom/server", () => ({ renderToReadableStream: vi.fn() }));

import { renderToReadableStream } from "react-dom/server";
import handleRequest from "~/entry.server";

function visitorRequest() {
  const signal = new AbortController().signal;
  const add = vi.spyOn(signal, "addEventListener");
  const remove = vi.spyOn(signal, "removeEventListener");
  // A desktop browser, not a bot: a bot's response waits for the whole render.
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  const request = { url: "https://pivotparlor.com/", signal, headers: new Headers({ "User-Agent": userAgent }) } as unknown as Request;
  return { request, add, remove };
}

const loadContext = { env: {}, waitUntil: () => {}, cspNonce: "test-nonce" } as never;

describe("entry.server render timer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(renderToReadableStream).mockReset();
  });

  it("a render that fails before streaming leaves no timer and no listener behind", async () => {
    vi.useFakeTimers();
    vi.mocked(renderToReadableStream).mockRejectedValue(new Error("shell failed"));
    const { request, add, remove } = visitorRequest();

    await expect(handleRequest(request, 200, new Headers(), {} as never, loadContext)).rejects.toThrow("shell failed");

    expect(vi.getTimerCount()).toBe(0);
    const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("abort", listener);
  });

  it("a render that streams keeps its timer until the stream settles, then clears it", async () => {
    vi.useFakeTimers();
    let settle: () => void = () => {};
    const allReady = new Promise<void>((resolve) => (settle = resolve));
    vi.mocked(renderToReadableStream).mockResolvedValue(Object.assign(new ReadableStream(), { allReady }) as never);
    const { request } = visitorRequest();

    const res = await handleRequest(request, 200, new Headers(), {} as never, loadContext);
    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(1);

    settle();
    await allReady;
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
