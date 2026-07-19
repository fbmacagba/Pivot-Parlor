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
  hasSocialProof: boolean;
  statsHappy: string;
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
