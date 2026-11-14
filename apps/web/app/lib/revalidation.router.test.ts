// jsdom (the suite's default): with no window, the router believes it is
// rendering on the server and refuses fetcher loads.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { skipRevalidationForWizardParams } from "./bookingUrl";
import { revalidateAfterFailedSubmission } from "./revalidation";

// The real router, with React Router 7's default switched on: after a
// submission answered 4xx/5xx, loaders and fetchers do not reload unless the
// route's shouldRevalidate says so. Under React Router 7 this is the default
// and the flag no longer exists, so the swap deletes the `future` line.
const RR7_DEFAULT = { v7_skipActionErrorRevalidation: true };

const passthrough: ShouldRevalidateFunction = ({ defaultShouldRevalidate }) => defaultShouldRevalidate;

const answer = (status: number) =>
  new Response(JSON.stringify({ error: "refused" }), { status, headers: { "Content-Type": "application/json" } });

async function post(router: ReturnType<typeof createMemoryRouter>, path: string) {
  await router.navigate(path, { formMethod: "post", formData: new FormData() });
}

describe("the booking page after a refused booking", () => {
  // The page shows times loaded by a fetcher from the booking route itself.
  async function bookingPage(shouldRevalidate: ShouldRevalidateFunction, status: number) {
    const timeLoads: string[] = [];
    const router = createMemoryRouter(
      [
        {
          id: "book",
          path: "/:shopSlug/book",
          loader: ({ request }) => {
            const url = new URL(request.url);
            if (url.searchParams.has("date")) timeLoads.push(url.search);
            return { slots: [] };
          },
          action: () => answer(status),
          shouldRevalidate,
        },
      ],
      { initialEntries: ["/linden-demo/book"], future: RR7_DEFAULT }
    );
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    router.fetch("times", "book", "/linden-demo/book?date=2026-11-20&service_id=svc-1");
    await vi.waitFor(() => expect(router.getFetcher("times").state).toBe("idle"));
    await vi.waitFor(() => expect(timeLoads).toHaveLength(1));
    await post(router, "/linden-demo/book");
    await vi.waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    await vi.waitFor(() => expect(router.getFetcher("times").state).toBe("idle"));
    const loads = timeLoads.length;
    router.dispose();
    return loads;
  }

  it("reloads the shown times after a clash (409), so the taken time disappears", async () => {
    expect(await bookingPage(skipRevalidationForWizardParams, 409)).toBe(2);
  });

  it("would not reload them under the router's own default (the control)", async () => {
    expect(await bookingPage(passthrough, 409)).toBe(1);
  });

  it("does not reload them after a validation error (400), when nothing changed", async () => {
    expect(await bookingPage(skipRevalidationForWizardParams, 400)).toBe(1);
  });

  it("loads its times from the booking route itself, so this rule is the one that decides", () => {
    const src = readFileSync(resolve(process.cwd(), "app/routes/$shopSlug.book.tsx"), "utf8");
    expect(src).toMatch(/slotsFetcher\.load\(`\/\$\{slug\}\/book\?/);
    expect(src).toMatch(/export const shouldRevalidate = skipRevalidationForWizardParams;/);
  });
});

describe("a dashboard page after a failed submission", () => {
  async function dashboardPage(shouldRevalidate: ShouldRevalidateFunction, status: number) {
    let loads = 0;
    const router = createMemoryRouter(
      [
        {
          id: "services",
          path: "/admin/services",
          loader: () => ({ services: [], load: ++loads }),
          action: () => answer(status),
          shouldRevalidate,
        },
      ],
      { initialEntries: ["/admin/services"], future: RR7_DEFAULT }
    );
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    await post(router, "/admin/services");
    await vi.waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    router.dispose();
    return loads;
  }

  it("reloads the page's data after the action answered 400 or 502", async () => {
    expect(await dashboardPage(revalidateAfterFailedSubmission, 400)).toBe(2);
    expect(await dashboardPage(revalidateAfterFailedSubmission, 502)).toBe(2);
  });

  it("would not reload it under the router's own default (the control)", async () => {
    expect(await dashboardPage(passthrough, 400)).toBe(1);
  });
});
