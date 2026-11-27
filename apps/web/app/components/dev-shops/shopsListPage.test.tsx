/**
 * The developer shops list, rendered: what a row shows, that search filters
 * in memory without a navigation, and that Pause is confirmed first and a
 * refusal is shown. Lives here rather than in routes/ so the router never
 * mounts it as a route.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

type FetcherState = "idle" | "submitting" | "loading";
interface FakeFetcher {
  state: FetcherState;
  data: unknown;
  formData: FormData | undefined;
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  Form: (props: ComponentProps<"form">) => ReactElement;
}

const shared = vi.hoisted(() => ({
  fetcher: null as unknown as FakeFetcher,
  loaderData: {} as unknown,
  search: "",
  setSearchParams: (() => undefined) as (...args: unknown[]) => void,
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={String(to)} {...(rest as object)}>
      {children}
    </a>
  ),
  // One fetcher stands in for all of the page's: each handler ignores an
  // answer that is not its own shape.
  useFetcher: () => shared.fetcher,
  useLoaderData: () => shared.loaderData,
  useSearchParams: () => [new URLSearchParams(shared.search), shared.setSearchParams],
  useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
}));
vi.mock(
  "lucide-react",
  () =>
    new Proxy(
      {},
      {
        get: (_t, key) => (key === "then" ? undefined : () => null),
        has: (_t, key) => key !== "then",
      },
    ),
);

import DevShops from "~/routes/dev.shops._index";
import type { Shop } from "./types";

const base = {
  type: "barber_shop",
  owner_name: "",
  is_active: 1,
  status: "active",
  plan: "standard",
} as const;
const LIVE: Shop = {
  ...base,
  id: "shop-live",
  shop_number: 1,
  name: "Fade & Blade",
  slug: "fade-and-blade-001",
  owner_email: "fade@example.com",
  has_site: 1,
  website_status: "live",
  ai_model: "openai-api/gpt-6-astra",
  booking_count: 12,
  commission_total_pence: 3450,
};
const NO_SITE: Shop = {
  ...base,
  id: "shop-new",
  shop_number: 2,
  name: "Curl Up",
  slug: "curl-up-002",
  owner_email: "curl@example.com",
  has_site: null,
  ai_model: "google/gemini-4-flash",
  booking_count: 1,
};

let root: Root;
let container: HTMLDivElement;

function mount(loaderData: unknown, search = "") {
  shared.loaderData = loaderData;
  shared.search = search;
  act(() => root.render(<DevShops />));
}
const rerender = () => act(() => root.render(<DevShops />));
const rows = () => [...document.body.querySelectorAll('[data-testid="shop-row"]')] as HTMLElement[];
const rowNames = () => rows().map((r) => r.querySelector("p span")?.textContent);
const button = (within: Element, name: string) =>
  [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

beforeEach(() => {
  shared.fetcher = {
    state: "idle",
    data: undefined,
    formData: undefined,
    submit: vi.fn(),
    load: vi.fn(),
    Form: (props) => <form {...props} />,
  };
  shared.setSearchParams = vi.fn();
  window.history.replaceState(null, "", "/dev/shops");
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

const DATA = { shops: [LIVE, NO_SITE], loadError: false, publicOrigin: "https://shops.test" };

describe("shops list rows", () => {
  it("shows bookings, commission and a public link built from the page's own origin", () => {
    mount(DATA);
    const [live, fresh] = rows();
    expect(live!.textContent).toContain("12 bookings");
    expect(live!.textContent).toContain("£34.50");
    expect(fresh!.textContent).toContain("1 booking");
    expect(fresh!.textContent).toContain("£0.00");
    const site = [...live!.querySelectorAll("a")].find((a) => a.textContent?.includes("View Website"));
    expect(site?.getAttribute("href")).toBe("https://shops.test/fade-and-blade-001");
  });

  it("badges a Gemini model as Google and another vendor's model as neutral, never blue", () => {
    mount(DATA);
    const [live, fresh] = rows();
    const badge = (row: HTMLElement, text: string) =>
      [...row.querySelectorAll("span")].find((s) => s.className.includes("rounded-full") && s.textContent === text);
    expect(badge(fresh!, "google/gemini 4 flash")?.className).toContain("blue");
    const other = badge(live!, "openai api/gpt 6 astra");
    expect(other).toBeDefined();
    expect(other!.className).not.toContain("blue");
  });

  it("says the load failed instead of 'No shops yet'", () => {
    mount({ shops: [], loadError: true, publicOrigin: "https://shops.test" });
    expect(document.body.querySelector('[data-testid="load-error"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("No shops yet");
  });
});

describe("shops list search", () => {
  it("opens already filtered from a ?q= link", () => {
    mount(DATA, "q=curl");
    expect(rowNames()).toEqual(["Curl Up"]);
  });

  it("filters as you type without a navigation, keeping the address in step", () => {
    mount(DATA);
    expect(rowNames()).toEqual(["Fade & Blade", "Curl Up"]);
    const search = document.body.querySelector('input[type="search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(search, "fade");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rowNames()).toEqual(["Fade & Blade"]);
    // No router navigation (that reran the loader on every keystroke)...
    expect(shared.setSearchParams).not.toHaveBeenCalled();
    // ...but the address still carries the search, for reload and sharing.
    expect(window.location.search).toBe("?q=fade");

    act(() => {
      setter.call(search, "zzz");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).toContain("No shops match your search.");
  });
});

describe("pausing a live site", () => {
  it("asks first, then shows a refusal and leaves the dialog open", () => {
    mount(DATA);
    act(() => button(rows()[0]!, "Pause")!.click());
    // Nothing is sent by the first click.
    expect(shared.fetcher.submit).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(
      "Take Fade & Blade's site offline? Customers will not be able to book until you resume it.",
    );

    act(() => button(dialog, "Pause site")!.click());
    expect(shared.fetcher.submit).toHaveBeenCalledWith({}, { method: "post", action: "/api/shops/shop-live/pause" });

    shared.fetcher.state = "submitting";
    rerender();
    expect(button(rows()[0]!, "Pausing…")!.disabled).toBe(true);

    shared.fetcher.state = "idle";
    shared.fetcher.data = { success: false, error: "Audit log unavailable" };
    rerender();
    const stillOpen = document.body.querySelector('[role="dialog"]')!;
    expect(stillOpen.querySelector('[role="alert"]')?.textContent).toContain("It is still live");
    expect(stillOpen.querySelector('[role="alert"]')?.textContent).toContain("Audit log unavailable");
  });
});
