export type SiteData = {
  /** Shop row id for chatbot and integrations. */
  shop_id?: string;
  shop_name: string;
  headline?: string;
  tagline: string;
  about?: string;
  font_heading?: string;
  font_body?: string;
  hero_image_url?: string;
  logo_url?: string;
  color_primary?: string;
  color_accent?: string;
  seo_title?: string;
  description?: string;
  rating?: number;
  review_count?: number;
  /** Per-shop design intent from the generation pipeline (WS-6). All optional —
   *  pre-WS-6 sites fall back to the template's stock copy and layout. */
  layout_mood?: string;
  brand_voice?: string;
  hero_cta?: string;
  about_title?: string;
  trust_signals?: string[];
  usps?: string[];
  /** Full 5-colour research palette (WS-6 item 3) — drives the page tokens. */
  palette?: Record<string, string> | null;
  /** Palette theming gate: tokens follow the palette only when >= 2. */
  design_version?: number;
};

export type ShopSettings = {
  phone?: string;
  address?: string;
  lat?: number;
  lng?: number;
  hours_json?: string;
  instagram_url?: string;
  facebook_url?: string;
  tiktok_url?: string;
  twitter_url?: string;
  youtube_url?: string;
  whatsapp_url?: string;
  linkedin_url?: string;
  show_instagram?: boolean;
  show_facebook?: boolean;
  show_tiktok?: boolean;
  show_twitter?: boolean;
  show_youtube?: boolean;
  show_whatsapp?: boolean;
  show_linkedin?: boolean;
  google_business_url?: string;
  show_google_business?: boolean;
  /** When false, booking nav links point to services instead. Omitted defaults to true. */
  booking_enabled?: boolean;
};
