import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";
import { AboutSplitImageSection } from "./AboutSplitImageSection";
import { AboutStorySection } from "./AboutStorySection";

const ctx = makeTestCtx();

describe("about split-image", () => {
  it("pairs the story with the shop's own imagery and chip pillars", () => {
    const html = renderToStaticMarkup(<AboutSplitImageSection ctx={ctx} density="airy" />);
    expect(html).toContain('id="about"');
    expect(html).toContain("one.jpg"); // first service image
    expect(html).toContain("Expert Staff"); // pillar chip
    expect(html).toContain("proper chairs");
  });
  it("falls back to an accent panel with no imagery anywhere", () => {
    const bare = makeTestCtx({ heroSrc: "" });
    bare.services = bare.services.map((s) => ({ ...s, image_url: undefined }));
    const html = renderToStaticMarkup(<AboutSplitImageSection ctx={bare} density="airy" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("bg-gradient-to-br");
  });
});

describe("about story", () => {
  it("centres the narrative under an oversized quote glyph", () => {
    const html = renderToStaticMarkup(<AboutStorySection ctx={ctx} density="airy" />);
    expect(html).toContain('id="about"');
    expect(html).toContain("“"); // decorative ldquo
    expect(html).toContain("proper chairs");
    expect(html).toContain("Expert Staff");
  });
});
