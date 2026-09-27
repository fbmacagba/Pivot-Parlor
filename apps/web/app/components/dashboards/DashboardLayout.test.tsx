(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** DashboardLayout: one layout renders the desktop rail and the phone shell
 *  (menu button, off-canvas drawer, bottom tab bar). SSR markup comes from
 *  renderToStaticMarkup (no effects: the pre-hydration page); drawer
 *  behaviour runs under createRoot + act. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

let pathname = "/staff";
const navigate = vi.fn();

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    Outlet: () => React.createElement("div", { "data-outlet": "" }, "page"),
    useLocation: () => ({ pathname }),
    useNavigate: () => navigate,
  };
});
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return {
    BarChart2: Icon,
    BarChart3: Icon,
    Bot: Icon,
    Boxes: Icon,
    Calendar: Icon,
    Users2: Icon,
    CalendarDays: Icon,
    Clock: Icon,
    CreditCard: Icon,
    Image: Icon,
    LayoutDashboard: Icon,
    LogOut: Icon,
    Menu: Icon,
    MessageSquare: Icon,
    Package: Icon,
    Receipt: Icon,
    Scissors: Icon,
    ScrollText: Icon,
    Settings: Icon,
    ShoppingBag: Icon,
    ShoppingCart: Icon,
    Users: Icon,
    X: Icon,
  };
});

import { DashboardLayout } from "./DashboardLayout";
import { mobileTabsFor } from "./MobileTabBar";

type Props = Parameters<typeof DashboardLayout>[0];

function ssr(props: Props): string {
  return renderToStaticMarkup(<DashboardLayout {...props} />);
}

/** The tab bar's own markup, from its nav through its closing tag. */
function tabBar(html: string): string {
  const start = html.indexOf('aria-label="Primary"');
  if (start < 0) return "";
  return html.slice(start, html.indexOf("</nav>", start));
}

describe("DashboardLayout: server markup", () => {
  it("hides the rail below md and offers the menu button; the drawer is closed", () => {
    pathname = "/staff";
    const html = ssr({ role: "staff", userName: "sam" });
    expect(html).toContain('class="hidden md:flex');
    expect(html).toContain('aria-label="Open menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("pp-dashboard");
  });

  it("staff: every destination is a tab, none is More, and the current one is marked", () => {
    pathname = "/staff";
    const bar = tabBar(ssr({ role: "staff", userName: "sam" }));
    expect(bar).not.toBe("");
    expect(bar).toContain('href="/staff" aria-current="page"');
    expect(bar).toContain('href="/staff/bookings"');
    expect(bar).toContain('href="/staff/pos"');
    expect(bar).toContain('href="/staff/availability"');
    expect(bar).toContain(">POS<");
    expect(bar).not.toContain("More");
    expect(bar.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("admin: the four priority tabs plus More; a drawer-only page marks no tab", () => {
    pathname = "/admin/settings";
    const bar = tabBar(ssr({ role: "admin", shopName: "Fade & Blade", userName: "ann" }));
    for (const href of ["/admin", "/admin/bookings", "/admin/queue", "/admin/pos"]) {
      expect(bar).toContain(`href="${href}"`);
    }
    expect(bar).toContain(">More<");
    expect(bar).not.toContain('href="/admin/settings"');
    expect(bar).not.toContain('aria-current="page"');
  });

  // Developer gained a 6th destination (Activity, Task 12) and has no
  // curated priority list like ADMIN_TAB_HREFS, so it now falls through
  // mobileTabsFor's generic overflow path: the first MAX_TABS - 1 items
  // (in Sidebar's DEV_NAV order) become tabs and the rest — Enquiries and
  // Activity — move behind More, same as any other role past the five-tab
  // cap. Nothing is hidden: More still opens the drawer with every item.
  it("developer: four tabs (in nav order) plus More once a sixth destination exists", () => {
    pathname = "/dev/shops";
    const bar = tabBar(ssr({ role: "developer", topBarTitle: "Pivot Parlor Platform" }));
    expect(bar.match(/<a /g)).toHaveLength(4);
    expect(bar).toContain('href="/dev/shops" aria-current="page"');
    expect(bar).toContain(">More<");
  });
});

describe("mobileTabsFor", () => {
  it("keeps the admin priority order and flags the overflow", () => {
    const { tabs, more } = mobileTabsFor("admin");
    expect(tabs.map((t) => t.href)).toEqual(["/admin", "/admin/bookings", "/admin/queue", "/admin/pos"]);
    expect(more).toBe(true);
  });

  it("developer: no curated priority list, so overflow keeps the first four nav items and flags More", () => {
    const { tabs, more } = mobileTabsFor("developer");
    expect(tabs.map((t) => t.href)).toEqual(["/dev", "/dev/shops", "/dev/revenue", "/dev/ai-deploy"]);
    expect(more).toBe(true);
  });

  it("gives small roles every destination and no More", () => {
    expect(mobileTabsFor("staff").more).toBe(false);
    expect(mobileTabsFor("customer").tabs).toHaveLength(0);
  });
});

describe("DashboardLayout: phone drawer", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    pathname = "/staff";
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    container.remove();
    document.body.style.overflow = "";
  });

  async function mount(props: Props) {
    root = createRoot(container);
    await act(async () => {
      root!.render(<DashboardLayout {...props} />);
    });
  }
  async function rerender(props: Props) {
    await act(async () => {
      root!.render(<DashboardLayout {...props} />);
    });
  }
  const dialog = () => container.querySelector('[role="dialog"]');
  const menuButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]')!;

  it("opens from the menu button, locks scroll, and closes when a destination is tapped", async () => {
    await mount({ role: "staff", userName: "sam" });
    expect(dialog()).toBeNull();

    await act(async () => menuButton().click());
    expect(dialog()).not.toBeNull();
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");

    const link = dialog()!.querySelector<HTMLAnchorElement>('a[href="/staff/pos"]')!;
    await act(async () => link.click());
    expect(dialog()).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("closes from its own close button and from the scrim", async () => {
    await mount({ role: "admin", userName: "ann" });

    await act(async () => menuButton().click());
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close menu"]')!.click());
    expect(dialog()).toBeNull();

    await act(async () => menuButton().click());
    expect(dialog()).not.toBeNull();
    await act(async () => container.querySelector<HTMLDivElement>(".pp-dash-scrim")!.click());
    expect(dialog()).toBeNull();
  });

  it("the More tab opens the drawer for admins, and a route change closes it", async () => {
    pathname = "/admin";
    await mount({ role: "admin", userName: "ann" });
    const more = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "More")!;
    expect(more).toBeDefined();

    await act(async () => more.click());
    expect(dialog()).not.toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("true");

    pathname = "/admin/queue";
    await rerender({ role: "admin", userName: "ann" });
    expect(dialog()).toBeNull();
  });
});
