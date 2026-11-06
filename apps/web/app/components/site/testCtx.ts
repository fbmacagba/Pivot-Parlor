import { archetypeFor } from "~/components/siteArchetype";
import type { SiteRenderContext } from "~/components/site/sectionContext";

/** Test-only SiteRenderContext builder for section-variant DOM tests. */
export function makeTestCtx(overrides: Partial<SiteRenderContext> = {}): SiteRenderContext {
  const archetype = archetypeFor("luxury-dark");
  const services = [
    { id: "s1", name: "Haircut", price_gbp: 25, duration_minutes: 30, category: "Hair", description: "Classic cut and finish.", image_url: "https://img.example/one.jpg" },
    { id: "s2", name: "Beard trim", price_gbp: 15, duration_minutes: 20, category: "Beard", image_url: "https://img.example/two.jpg" },
    { id: "s3", name: "Hot towel shave", price_gbp: 35, duration_minutes: 45, image_url: "https://img.example/three.jpg" },
  ];
  return {
    site: { shop_id: "test-shop-id", shop_name: "Test Shop", tagline: "Walk out sharper", design_version: 3, rating: 4.8, review_count: 12 },
    settings: { address: "1 High St, London", phone: "020 1234 5678" },
    shopSlug: "test-shop",
    services,
    filteredServices: services,
    categories: ["All", "Beard", "Hair"],
    category: "All",
    setCategory: () => {},
    staff: [
      { id: "st1", display_name: "Alex Doe", speciality: "Fades", bio: "Ten years on the chair." },
      { id: "st2", display_name: "Jo Bloggs" },
    ],
    sortedReviews: [
      { id: "r1", customer_name: "Sam", rating: 5, body: "Great cut, will be back.", created_at: "2026-01-05T10:00:00Z" },
      { id: "r2", customer_name: "Ash", rating: 4, body: "Friendly and quick.", created_at: "2026-01-04T10:00:00Z" },
    ],
    reviewCount: 12,
    hasAddress: true,
    hasVisitInfo: true,
    illustrativeContact: false,
    galleryImages: [],
    hasSocialProof: true,
    statsRating: "4.8",
    trustSignals: ["Walk-ins welcome", "5-star rated"],
    heroSubline: "Walk-ins welcome · 5-star rated",
    heroHeadline: "Test Shop",
    heroTagline: "Walk out sharper",
    heroSrc: "https://img.example/hero.jpg",
    aboutText: "A neighbourhood shop with proper chairs.",
    aboutHeading: "Why us",
    bookLabel: "Book now",
    pillars: [
      { title: "Expert Staff", icon: null },
      { title: "Easy Booking", icon: null },
      { title: "Guaranteed Satisfaction", icon: null },
    ],
    steps: archetype.steps.map((s, i) => ({ n: String(i + 1), t: s.t, d: s.d, icon: null })),
    archetype,
    scrollToId: () => {},
    ...overrides,
  };
}
