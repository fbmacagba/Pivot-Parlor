/** Renders 24 seeded specs (plus off/lively overrides) through the full
 *  template: every seed must produce a bookable page, never a crash. */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { seedComposeDesignSpec, type MotionIntensity } from "@repo/utils";

vi.mock("@remix-run/react", async () => {
  const React = await import("react");
  return {
    Link: ({ to, children, ...rest }: { to: string; children?: unknown } & Record<string, unknown>) =>
      React.createElement("a", { href: String(to), ...rest }, children as never),
    useParams: () => ({ shopSlug: "sweep-shop" }),
  };
});
vi.mock("~/components/CommercialShopChrome", async () => {
  const React = await import("react");
  return {
    CommercialShopChrome: ({ children }: { children: unknown }) =>
      React.createElement("div", null, children as never),
  };
});

import CommercialTemplate from "~/components/CommercialTemplate";

const services = [
  { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30, category: "Hair", image_url: "https://img.example/a.jpg" },
  { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20, image_url: "https://img.example/b.jpg" },
  { id: "s3", name: "Hot towel shave", price_gbp: 35, duration_minutes: 45, image_url: "https://img.example/c.jpg" },
];
const staff = [{ id: "st1", display_name: "Alex Doe" }];
const reviews = [
  { id: "r1", customer_name: "Sam", rating: 5, body: "Great cut.", created_at: "2026-01-05T10:00:00Z" },
  { id: "r2", customer_name: "Ash", rating: 4, body: "Quick and friendly.", created_at: "2026-01-04T10:00:00Z" },
];

describe("seeded sweep", () => {
  const intensities: MotionIntensity[] = ["off", "calm", "lively"];
  for (let i = 0; i < 24; i++) {
    const shopId = `sweep-shop-${i}`;
    for (const intensity of intensities) {
      it(`renders ${shopId} (${intensity}) bookable`, () => {
        const spec = seedComposeDesignSpec(shopId);
        const html = renderToStaticMarkup(
          <CommercialTemplate
            site={{
              shop_id: shopId,
              shop_name: `Sweep Shop ${i}`,
              tagline: "Sharp",
              hero_image_url: "https://img.example/hero.jpg",
              design_version: 3,
              design_spec: { ...spec, motion: { ...spec.motion, intensity } },
            }}
            services={services}
            staff={staff}
            reviews={reviews}
            settings={{ address: "1 High St" }}
          />,
        );
        expect(html).toContain(`Sweep Shop ${i}`);
        expect(html).toContain("/sweep-shop/book"); // a booking path always renders
        expect(html).toContain('id="services"'); // services section always present
      });
    }
  }
});
