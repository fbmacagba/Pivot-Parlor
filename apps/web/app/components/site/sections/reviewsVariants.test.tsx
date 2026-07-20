import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { makeTestCtx } from "~/components/site/testCtx";
import { ReviewsMarqueeSection } from "./ReviewsMarqueeSection";
import { ReviewsSpotlightSection } from "./ReviewsSpotlightSection";

const ctx = makeTestCtx();

describe("reviews marquee", () => {
  it("renders a doubled track when animating", () => {
    const html = renderToStaticMarkup(<ReviewsMarqueeSection ctx={ctx} density="airy" animate />);
    expect(html).toContain("st-marquee-track");
    const first = html.indexOf("Great cut, will be back.");
    const second = html.indexOf("Great cut, will be back.", first + 1);
    expect(second).toBeGreaterThan(first); // duplicated for the seamless loop
    expect(html).toContain("aria-hidden");
  });
  it("renders a hand-scrollable rail when motion is off", () => {
    const html = renderToStaticMarkup(<ReviewsMarqueeSection ctx={ctx} density="airy" animate={false} />);
    expect(html).not.toContain("st-marquee-track");
    expect(html).toContain("overflow-x-auto");
  });
  it("renders nothing without reviews and honours a custom heading", () => {
    expect(renderToStaticMarkup(<ReviewsMarqueeSection ctx={makeTestCtx({ sortedReviews: [] })} density="airy" animate />)).toBe("");
    expect(
      renderToStaticMarkup(<ReviewsMarqueeSection ctx={ctx} density="airy" animate heading="What clients say" />),
    ).toContain("What clients say");
  });
});

describe("reviews spotlight", () => {
  it("features the strongest quote large with the rest in a grid", () => {
    const html = renderToStaticMarkup(<ReviewsSpotlightSection ctx={ctx} density="airy" />);
    // r1 (rating 5) leads; r2 lands in the small grid after it.
    expect(html.indexOf("Great cut, will be back.")).toBeLessThan(html.indexOf("Friendly and quick."));
    expect(html).toContain("<figure");
  });
  it("renders nothing without reviews", () => {
    expect(renderToStaticMarkup(<ReviewsSpotlightSection ctx={makeTestCtx({ sortedReviews: [] })} density="airy" />)).toBe("");
  });
});
