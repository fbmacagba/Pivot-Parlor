import type { Service as ApiService } from "@repo/types";
import { PORTFOLIO_DEMO_ID, PORTFOLIO_DEMO_SLUG } from "@repo/utils";
import type {
  Review,
  Service,
  ShopSettings,
  StaffMember,
} from "~/components/CommercialTemplate";
import type { ShopSiteData } from "~/routes/$shopSlug";

export const portfolioDemoServices: ApiService[] = [
  {
    id: "demo-classic",
    name: "Classic haircut",
    description: "An illustrative haircut service with a tidy finish.",
    durationMinutes: 30,
    price_pence: 2500,
    category: "Hair",
    isActive: true,
  },
  {
    id: "demo-clipper",
    name: "Clipper cut",
    description: "An illustrative all-over clipper cut.",
    durationMinutes: 30,
    price_pence: 1200,
    category: "Hair",
    isActive: true,
  },
  {
    id: "demo-restyle",
    name: "Restyle & finish",
    description: "An illustrative longer appointment for a change of style.",
    durationMinutes: 45,
    price_pence: 3000,
    category: "Hair",
    isActive: true,
  },
].map((service) => ({ ...service, shopId: PORTFOLIO_DEMO_ID }));

export const portfolioDemoStaff: StaffMember[] = [
  {
    id: "demo-alex",
    display_name: "Alex Morgan",
    bio: "Illustrative team member for this demonstration.",
  },
  {
    id: "demo-jamie",
    display_name: "Jamie Lee",
    bio: "Illustrative team member for this demonstration.",
  },
];

/** Static stand-in for the ORIGINAL demo URL only, served until the fictional
 *  backing shop (pp-demo-ferdyms-barber) is provisioned and live; the loaders
 *  prefer the generated shop the moment it exists. Delete after rollout. */
export function getPortfolioDemoData() {
  const site: ShopSiteData = {
    template: "commercial",
    headline: "Precision Grooming, Perfected",
    tagline:
      "Explore a branded barber shop website, sample assistant and booking experience built with Pivot Parlor.",
    about:
      "This fictional shop demonstrates how a branded website connects services, a team and an online booking flow. All services, prices and team members shown here are illustrative.",
    color_primary: "#171715",
    color_accent: "#85bc89",
    font_heading: "Playfair Display",
    font_body: "DM Sans",
    hero_image_url: null,
    logo_url: null,
    catalog_images: [],
    services: [],
    seo_title: "FerdyM's Barber Shop | Pivot Parlor demo",
    seo_description:
      "Explore a fictional barber shop and a safe, interactive booking demonstration by BytesFX. No real appointments or payments.",
    website_status: "live",
    hero_cta: "Try a demo booking",
    about_title: "A working example, clearly labelled",
    trust_signals: [
      "Example services and team",
      "Scripted sample assistant",
      "No real appointments or payments",
    ],
    usps: [
      "A website for the shop's own brand",
      "An interactive booking walkthrough",
      "Clearly labelled sample content",
    ],
  };
  const settings: ShopSettings = { booking_enabled: true };
  const commercialServices: Service[] = portfolioDemoServices.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    price_gbp: s.price_pence / 100,
    duration_minutes: s.durationMinutes,
  }));
  return {
    slug: PORTFOLIO_DEMO_SLUG,
    shop: {
      id: PORTFOLIO_DEMO_ID,
      name: "FerdyM's Barber Shop",
      slug: PORTFOLIO_DEMO_SLUG,
      phone: undefined,
      created_at: undefined,
    },
    site,
    commercialServices,
    staff: portfolioDemoStaff,
    reviews: [] as Review[],
    settings,
  };
}

