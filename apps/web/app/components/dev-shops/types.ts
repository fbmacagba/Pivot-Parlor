// Types for the developer "Shops" dashboard (dev.shops route).
// Extracted from dev.shops.tsx (T7.7) — no behavior change.

export interface Shop {
  id: string;
  shop_number: number;
  name: string;
  slug: string;
  type: string;
  owner_name: string;
  owner_email: string;
  bookings_count?: number;
  revenue_pence?: number;
  commission_pence?: number;
  ai_model?: string;
  is_active: number;
  status: string;
  plan: string;
  commission_rate?: number;
  retail_commission_rate?: number;
  has_site?: number | null;
  stripe_payment_status?: string;
  stripe_checkout_url?: string | null;
  website_status?: string | null;
  hero_image_url?: string | null;
  logo_url?: string | null;
}

export interface GenerateSiteActionResult {
  success: boolean;
  generateJobId?: string;
  generateShopSlug?: string;
  generateShopId?: string;
  generateSite?: { template: string; slug: string } | null;
  error?: string | null;
}

export interface OnboardResult {
  shop: { id: string; slug: string; name: string };
  invite_token?: string;
  checkout_url?: string;
}

export type RegenStepUiState = "pending" | "active" | "done" | "failed";

export type OnboardActionJson =
  | { success: true; result: OnboardResult; error: null }
  | { success: false; result: null; error: string };

export type DevShopsActionJson = OnboardActionJson | GenerateSiteActionResult;
