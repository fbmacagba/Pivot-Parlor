// sectionContext.ts — the data every section may need, built once per render.
import type { ReactNode } from "react";
import type { SiteData, ShopSettings } from "~/components/commercialSiteTypes";
import type { StaffMember, Service, Review } from "~/components/CommercialTemplate";
import type { Archetype } from "~/components/siteArchetype";

export interface SitePillar { title: string; body?: string; icon: ReactNode }
export interface SiteStep { n: string; t: string; d: string; icon: ReactNode }

export interface SiteRenderContext {
  site: SiteData;
  settings: ShopSettings;
  shopSlug: string;
  services: Service[];
  filteredServices: Service[];
  categories: string[];
  category: string;
  setCategory: (c: string) => void;
  staff: StaffMember[];
  sortedReviews: Review[];
  reviewCount: number;
  hasAddress: boolean;
  /** Address, opening hours or a phone number: enough for a visit section. */
  hasVisitInfo: boolean;
  /** A fictional demo: address and phone are labelled illustrative, no map. */
  illustrativeContact: boolean;
  /** Generated "the space" photos, in order. */
  galleryImages: string[];
  /** True only with real published reviews AND a real average rating. */
  hasSocialProof: boolean;
  /** Average of the shop's own reviews ("4.7"); "" when there are none. */
  statsRating: string;
  trustSignals: string[];
  heroSubline: string;
  heroHeadline: string;
  heroTagline: string;
  heroSrc: string;
  aboutText: string;
  aboutHeading: string;
  bookLabel: string;
  pillars: SitePillar[];
  steps: SiteStep[];
  archetype: Archetype; // copy source (howSub, cta*, steps text) for BOTH paths
  scrollToId: (id: string) => void;
}
