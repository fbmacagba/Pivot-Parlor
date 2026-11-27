/**
 * The dialogs that react to a fetcher's outcome, driven through a fetcher's
 * real life cycle: idle, submitting, loading (the page's data reloading), idle
 * again, with its last answer kept for good.
 *
 * Each of these broke on that life cycle before:
 *  - the delete and rates dialogs closed themselves the moment they were
 *    opened for a second shop, because the first save's answer was still there;
 *  - the enquiry onboarding dialog never showed its outcome at all, because it
 *    waited for "submitting" to be followed directly by "idle".
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentProps, type ReactElement } from "react";
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
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Link: ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
    <a href={String(to)} {...(rest as object)}>
      {children}
    </a>
  ),
  useFetcher: () => shared.fetcher,
  useLoaderData: () => shared.loaderData,
  useNavigation: () => ({ state: "idle" }),
  useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
}));
// The icons are decoration here, and lucide's CJS build resolves its own React.
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

import { DeleteShopDialog } from "./DeleteShopDialog";
import { RatesDialog, type RatesActionResult } from "./RatesDialog";
import DevEnquiries from "~/routes/dev.enquiries";
import type { Shop } from "./types";

function newFetcher(): FakeFetcher {
  return {
    state: "idle",
    data: undefined,
    formData: undefined,
    submit: vi.fn(),
    load: vi.fn(),
    Form: (props) => <form {...props} />,
  };
}

const SHOP_A = {
  id: "shop-a",
  shop_number: 1,
  name: "Fade & Blade",
  slug: "fade-and-blade-001",
  type: "barber_shop",
  owner_name: "",
  owner_email: "a@example.com",
  is_active: 1,
  status: "active",
  plan: "standard",
  has_site: 1,
  website_status: "live",
  booking_count: 12,
} satisfies Shop;
const SHOP_B = { ...SHOP_A, id: "shop-b", name: "Curl Up", slug: "curl-up-002", booking_count: 0 } satisfies Shop;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  shared.fetcher = newFetcher();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // Radix portals its dialogs into <body>; start the next test from an empty one.
  document.body.replaceChildren();
});

const render = (ui: ReactElement) => act(() => root.render(ui));
/** One step of the fetcher's life, then a re-render, as the router would cause. */
function step(ui: ReactElement, state: FetcherState, data?: unknown) {
  shared.fetcher.state = state;
  if (data !== undefined) shared.fetcher.data = data;
  render(ui);
}
const text = () => document.body.textContent ?? "";
const button = (name: string | RegExp) =>
  [...document.body.querySelectorAll("button")].find((b) =>
    typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("RatesDialog", () => {
  it("closes once after a save, and stays open when reopened for another shop", () => {
    const onClose = vi.fn();
    const ui = (shop: Shop | null) => (
      <RatesDialog shop={shop} onClose={onClose} fetcher={shared.fetcher as never} />
    );
    render(ui(SHOP_A));
    expect(text()).toContain("Commission rates: Fade & Blade");

    step(ui(SHOP_A), "submitting");
    step(ui(SHOP_A), "loading", { success: true, ratesUpdated: true } satisfies RatesActionResult);
    expect(onClose).not.toHaveBeenCalled();
    step(ui(SHOP_A), "idle");
    expect(onClose).toHaveBeenCalledTimes(1);

    // The parent closes it, then opens it for another shop. The fetcher is
    // idle and still holds the first save's answer.
    render(ui(null));
    render(ui(SHOP_B));
    render(ui(SHOP_B));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Commission rates: Curl Up");
  });

  it("shows a refused save in the dialog and keeps it open", () => {
    const onClose = vi.fn();
    const ui = () => <RatesDialog shop={SHOP_A} onClose={onClose} fetcher={shared.fetcher as never} />;
    render(ui());
    step(ui(), "submitting");
    step(ui(), "idle", { success: false, ratesUpdated: false, error: "Rates must be between 0 and 100 percent" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("between 0 and 100");
  });
});

describe("DeleteShopDialog", () => {
  it("needs the slug typed, says what is lost, and can be opened again after a delete", () => {
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    const ui = (shop: Shop | null) => <DeleteShopDialog shop={shop} onClose={onClose} onDeleted={onDeleted} />;
    render(ui(SHOP_A));

    expect(text()).toContain("staff accounts, services, bookings and history");
    expect(text()).toContain("12 bookings will be deleted");
    expect(text()).toContain("live now");
    expect(text()).toContain("cannot be undone");

    const confirm = () => button("Delete shop")!;
    expect(confirm().disabled).toBe(true);
    const input = document.body.querySelector("input")!;
    type(input, "fade-and-blade");
    expect(confirm().disabled).toBe(true);
    type(input, "fade-and-blade-001");
    expect(confirm().disabled).toBe(false);

    act(() => confirm().click());
    expect(shared.fetcher.submit).toHaveBeenCalledWith({}, { method: "post", action: "/api/shops/shop-a/delete" });

    step(ui(SHOP_A), "submitting");
    step(ui(SHOP_A), "loading", { success: true });
    step(ui(SHOP_A), "idle");
    expect(onDeleted).toHaveBeenCalledWith("shop-a");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Opened for the next shop: the old answer must not close it again.
    render(ui(null));
    render(ui(SHOP_B));
    render(ui(SHOP_B));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Delete Curl Up?");
    // Nothing typed for this shop yet, so the button is locked again.
    expect(button("Delete shop")!.disabled).toBe(true);
  });

  it("shows a refused delete in the dialog, and not on the next shop", () => {
    const onClose = vi.fn();
    const ui = (shop: Shop | null) => <DeleteShopDialog shop={shop} onClose={onClose} />;
    render(ui(SHOP_A));
    step(ui(SHOP_A), "submitting");
    step(ui(SHOP_A), "idle", { success: false, error: "Shop has unsettled payouts" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("unsettled payouts");

    render(ui(null));
    render(ui(SHOP_B));
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("Enquiries: onboarding a shop from an enquiry", () => {
  const ENQUIRY = {
    id: "enq-1",
    full_name: "Sam Carter",
    shop_name: "Carter Cuts",
    shop_type: "barber_shop",
    email: "sam@carter.test",
    phone: null,
    message: "Please call me",
    created_at: "2026-11-20T10:00:00Z",
    onboarded_at: null,
  };
  const page = () => <DevEnquiries />;

  beforeEach(() => {
    shared.loaderData = { enquiries: [ENQUIRY], loadError: false, olderMissing: false, shown: 100, hasMore: false };
    render(page());
    act(() => button(/^Onboard/)!.click());
  });

  it("shows the payment link once the shop is created, and stops a second submit", () => {
    expect(text()).toContain("Onboard shop from enquiry");
    expect(button("Create shop")!.disabled).toBe(false);

    step(page(), "submitting");
    // Locked for the whole submission, including while the page's data reloads.
    expect(button("Creating…")!.disabled).toBe(true);
    step(page(), "loading", {
      success: true,
      shop: { id: "shop-9", slug: "carter-cuts-009", name: "Carter Cuts" },
      checkout_url: "https://checkout.stripe.com/c/pay_123",
    });
    expect(button("Creating…")!.disabled).toBe(true);

    step(page(), "idle");
    expect(text()).toContain("Shop created");
    expect(text()).toContain("carter-cuts-009");
    expect(text()).toContain("https://checkout.stripe.com/c/pay_123");
    // The form is gone, so the same enquiry cannot be submitted twice.
    expect(text()).not.toContain("Onboard shop from enquiry");
    expect(button("Create shop")).toBeUndefined();
  });

  it("shows a refusal in the form and lets it be corrected", () => {
    step(page(), "submitting");
    step(page(), "loading", { success: false, error: "That slug is already taken" });
    step(page(), "idle");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("That slug is already taken");
    expect(text()).toContain("Onboard shop from enquiry");
    expect(button("Create shop")!.disabled).toBe(false);
  });

  it("says so when the list could not be loaded, instead of 'No enquiries yet'", () => {
    shared.loaderData = { enquiries: [], loadError: true, olderMissing: false, shown: 100, hasMore: false };
    render(page());
    expect(document.body.querySelector('[data-testid="load-error"]')).not.toBeNull();
    expect(text()).not.toContain("No enquiries yet");
  });
});
