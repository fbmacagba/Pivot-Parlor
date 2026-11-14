import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTACT_FIELD_LIMITS } from "@repo/utils";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Form: ({ children, ...rest }: { children?: unknown } & Record<string, unknown>) =>
      React.createElement("form", rest, children as never),
    useActionData: () => undefined,
    useNavigation: () => ({ state: "idle" }),
  };
});

import Contact, { action, links } from "~/routes/_marketing.contact";

describe("/contact markup", () => {
  // The implicit-render hooks (a .cf-turnstile div and a plain api.js
  // script) broke hydration on production; see TurnstileWidget.test.tsx.
  it("carries no Turnstile implicit-render hooks", () => {
    const html = renderToStaticMarkup(<Contact />);
    expect(html).toContain("<form");
    expect(html).not.toContain("cf-turnstile");
    expect(html).not.toContain("<script");
  });

  it("preloads only the explicit-render script it actually loads", () => {
    for (const link of links()) {
      if ("href" in link && String(link.href).includes("challenges.cloudflare.com")) {
        expect(link.href).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
      }
    }
  });

  // The shop type select and the message textarea had bare <label>s, so a
  // screen reader announced them with no name.
  it("labels every visible form control", () => {
    const html = renderToStaticMarkup(<Contact />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const controls = [...doc.querySelectorAll("input, select, textarea")].filter(
      (el) => el.getAttribute("type") !== "hidden",
    );
    expect(controls).toHaveLength(6);
    for (const el of controls) {
      const name = el.getAttribute("name");
      expect(el.id, `${name} has no id`).not.toBe("");
      expect(doc.querySelector(`label[for="${el.id}"]`), `${name} has no label`).not.toBeNull();
    }
  });

  // The API refuses a field over its cap (apps/worker/src/routes/contact.ts).
  // The form carries the same caps, so a visitor meets them while typing.
  it("caps every text field at the length the API accepts", () => {
    const html = renderToStaticMarkup(<Contact />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const caps = Object.fromEntries(
      Object.keys(CONTACT_FIELD_LIMITS).map((name) => [
        name,
        doc.querySelector(`[name="${name}"]`)?.getAttribute("maxlength") ?? null,
      ]),
    );
    expect(caps).toEqual({
      full_name: "120",
      shop_name: "120",
      email: "254",
      phone: "40",
      message: "2000",
    });
  });
});

describe("/contact action, when the API refuses the enquiry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Submits a filled form; the API answers POST /api/contact with `status` and `body`. */
  async function submit(status: number, body: unknown): Promise<{ status: number; body: unknown; sent: string[] }> {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        sent.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return Response.json(body, { status });
      }),
    );
    const form = new URLSearchParams({
      full_name: "Casey Example",
      shop_name: "Example Cuts",
      shop_type: "barber_shop",
      email: "casey@example.test",
      message: "Hello",
    });
    const res = (await action({
      request: new Request("https://pivotparlor.com/contact", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: { env: { API_URL: "https://api.test" } },
    } as never)) as Response;
    return { status: res.status, body: await res.json(), sent };
  }

  // The API's 4xx is the sender's to fix (a field too long, too many tries),
  // not a fault on the site, so it keeps its status rather than becoming 500.
  it.each([
    [400, "full_name is too long (120 characters at most)"],
    [429, "Too many requests"],
  ])("passes the API's %i on with its message", async (status, error) => {
    const r = await submit(status, { success: false, error });
    expect(r).toEqual({ status, body: { success: false, error }, sent: ["POST /api/contact"] });
  });

  it("answers 500 when the API fails", async () => {
    const r = await submit(500, { success: false, error: "Internal error" });
    expect(r.status).toBe(500);
  });

  it("answers success when the API stores the enquiry (control)", async () => {
    const r = await submit(201, { success: true, data: { id: "c-1" } });
    expect(r).toEqual({ status: 200, body: { success: true }, sent: ["POST /api/contact"] });
  });
});
