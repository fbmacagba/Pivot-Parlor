(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FloatingCTA } from "~/components/marketing/FloatingCTA";

/**
 * On a phone the button's words are display:none (`hidden sm:inline`), and
 * a display:none element gives a link no name. Lighthouse found the link
 * nameless on the home page. jsdom applies no Tailwind, so the phone layout
 * is modelled here: every element carrying the `hidden` class is removed,
 * as that breakpoint removes it.
 *
 * Rendered in the browser with the cookie notice already answered: the
 * button is never in the server's HTML, and waits for that answer
 * (aboveCookieNotice.test.tsx).
 */
function nameAtPhoneWidth(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const link = doc.querySelector("a");
  if (!link) throw new Error("FloatingCTA rendered no link");
  for (const el of [...link.querySelectorAll("*")]) {
    if (el.classList.contains("hidden")) el.remove();
  }
  return (link.getAttribute("aria-label") ?? link.textContent ?? "").trim();
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(path: string): Promise<string> {
  localStorage.setItem("pp_platform_consent", JSON.stringify({ decided: true }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <FloatingCTA />
      </MemoryRouter>,
    );
  });
  return container.innerHTML;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  localStorage.clear();
});

describe("FloatingCTA", () => {
  it("has a name on a phone, where its words are hidden", async () => {
    expect(nameAtPhoneWidth(await render("/"))).toBe("Get your shop on Pivot");
  });

  it("is not shown on the contact page it links to (control)", async () => {
    expect(await render("/contact")).toBe("");
  });
});
