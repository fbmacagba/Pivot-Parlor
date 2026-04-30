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
