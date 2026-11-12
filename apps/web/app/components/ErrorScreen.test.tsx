(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** ErrorScreen hands a page that broke in the browser to the browser-error alert. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const routeError = vi.hoisted(() => ({ current: undefined as unknown }));
const reported = vi.hoisted(() => [] as Array<[unknown, string]>);

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    useRouteError: () => routeError.current,
    // Remix's own check: an ErrorResponse has status, statusText, internal and data.
    isRouteErrorResponse: (e: unknown) =>
      typeof e === "object" && e !== null && "status" in e && "statusText" in e && "internal" in e && "data" in e,
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
  };
});
vi.mock("~/lib/browserErrorReporter", () => ({
  reportBrowserError: (error: unknown, kind: string) => reported.push([error, kind]),
}));

import { ErrorScreen } from "./ErrorScreen";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  reported.length = 0;
});

function mount(error: unknown) {
  routeError.current = error;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ErrorScreen />));
}

describe("ErrorScreen", () => {
  it("reports a page that broke while rendering", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'name')");
    mount(error);
    expect(reported).toEqual([[error, "render"]]);
  });

  it("does not report a deliberate response such as a 404", () => {
    mount({ status: 404, statusText: "Not Found", internal: true, data: null });
    expect(reported).toEqual([]);
    expect(container?.textContent).toContain("Page not found");
  });
});
