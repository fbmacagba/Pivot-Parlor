export interface SiteTemplateProps {
  shop: { name: string; slug: string };
  site: {
    headline: string;
    tagline: string;
    about: string;
    services: Array<{
      name: string;
      duration_minutes: number;
      price_gbp: number;
      description: string;
    }>;
    color_primary: string;
    color_accent: string;
    font_heading: string;
    font_body: string;
    hero_image_url: string | null;
    logo_url: string | null;
    catalog_images: string[];
  };
}
