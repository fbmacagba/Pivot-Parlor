import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { FloatingCTA } from "~/components/marketing/FloatingCTA";

/**
 * On a phone the button's words are display:none (`hidden sm:inline`), and
 * a display:none element gives a link no name. Lighthouse found the link
 * nameless on the home page. jsdom applies no Tailwind, so the phone layout
 * is modelled here: every element carrying the `hidden` class is removed,
 * as that breakpoint removes it.
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

describe("FloatingCTA", () => {
  it("has a name on a phone, where its words are hidden", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/"]}>
        <FloatingCTA />
      </MemoryRouter>,
    );
    expect(nameAtPhoneWidth(html)).toBe("Get your shop on Pivot");
  });

  it("is not shown on the contact page it links to (control)", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/contact"]}>
        <FloatingCTA />
      </MemoryRouter>,
    );
    expect(html).toBe("");
  });
});
