import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Form: ({ children, ...rest }: { children?: unknown } & Record<string, unknown>) =>
      React.createElement("form", rest, children as never),
    useActionData: () => undefined,
    useNavigation: () => ({ state: "idle" }),
  };
});

import Contact, { links } from "~/routes/_marketing.contact";

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
});
