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
});
