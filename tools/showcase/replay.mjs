/**
 * Replayed model responses for the showcase run.
 *
 * HONESTY NOTE: these are AUTHORED responses, written for this run in the
 * shape the research and text prompts ask for, and returned to the real
 * workers in place of a paid model call. Everything downstream of the model
 * ran unmodified: research's schema validation, count coercion, deterministic
 * catalog prompts, gallery normalisation and curated-font forcing; the text
 * worker's menu-from-source rule; the assembler's truthfulness gate,
 * no-downgrade image merge and publication write; and the public renderer.
 * A live run would send the same prompts to the configured model and could
 * word things differently.
 *
 * The copy states only what the owner records in shops.mjs contain (team,
 * specialisms, area, opening days, services) plus the owner's style notes.
 */
import { promptFor } from "./image-prompts.mjs";

const legal = (shop, kind) =>
  `${shop} is a fictional demonstration shop on the Pivot Parlor platform. ` +
  `It takes no real bookings or payments and collects no personal data. ` +
  `This ${kind} illustrates where a real shop's ${kind} appears; a real shop replaces it with its own, ` +
  `naming the business as data controller and giving its contact details.`;

const socials = {
  instagram_url: "",
  facebook_url: "",
  tiktok_url: "",
  twitter_url: "",
  youtube_url: "",
  whatsapp_url: "",
  linkedin_url: "",
};

const ferdymsCopy = {
  "Skin fade":
    "A clipper fade taken down to the skin, blended by hand and finished with a razor line. Suits anyone after a clean, sharp shape.",
  "Scissor cut":
    "A full cut with scissors and comb, shaped to how your hair grows. Good for longer styles or a softer finish than clippers give.",
  "Cut & beard": "Any haircut plus a beard sculpt and line-up in one appointment.",
  "Kids' cut (under 12)": "A short, patient cut for under-12s, with time to settle into the chair.",
  "Beard sculpt & line-up":
    "Beard trimmed and shaped to your face, with the cheek and neck lines cleaned up with a razor.",
  "Hot towel shave":
    "A traditional wet shave: hot towels, a rich lather and a straight razor, finished with a cool towel and balm.",
};

const lindenCopy = {
  "Cut & finish":
    "A wash, cut and blow-dry finish, shaped to how your hair falls and how you style it at home.",
  "Restyle consultation & cut":
    "A longer appointment for a real change: we talk through shape, upkeep and texture before cutting.",
  "Blow-dry": "A wash and blow-dry, smooth or with volume, for an evening out or a fresh start to the week.",
  Balayage: "Hand-painted colour for a soft, lived-in result that grows out gently between appointments.",
  "Root colour": "Colour applied to regrowth to match your lengths, for covering greys or keeping a shade even.",
  "Gloss toner": "A quick gloss to refresh tone and add shine between colour appointments.",
  "Bond repair treatment":
    "A strengthening treatment for hair that feels dry or fragile after colour or heat styling.",
};

export const RESEARCH = {
  ferdyms: {
    palette: { primary: "#1F3A2E", accent: "#B8893B", background: "#0F1512", text: "#ECE5D5", muted: "#A39E8F" },
    typography: { heading_font: "Jost", body_font: "Work Sans", heading_weight: "700", heading_style: "sans-serif" },
    layout_mood: "luxury-dark",
    brand_voice:
      "Plain-spoken, precise and warm, like a barber who knows your name. Confident about the craft without ever overselling it.",
    content: {
      headline: "Sharp fades and slow shaves in Deptford",
      subheadline: "A small green-tiled barbershop where Kofi, Dan and Ruby take their time over every cut and shave.",
      hero_cta: "Book your cut",
      about_title: "A neighbourhood shop, done properly",
      about_body:
        "FerdyM's is a small barbershop in Deptford with deep green tiles, brass fittings and warm light. Kofi looks after skin fades and beard sculpting, Dan handles scissor cuts and hot towel shaves, and Ruby takes care of textured hair and kids' cuts. Every price is on the menu, and you choose who you sit with when you book. We are open Tuesday to Saturday.",
      trust_signals: ["Open Tuesday to Saturday", "Choose from 3 barbers", "6 services, clearly priced"],
      unique_selling_points: [
        "Skin fades and beard sculpting with Kofi",
        "Hot towel shaves with Dan",
        "Textured hair and kids' cuts with Ruby",
      ],
      seo_title: "FerdyM's Barber Shop | Barber in Deptford, London",
      seo_description:
        "Skin fades, scissor cuts, beard sculpting and hot towel shaves in Deptford. See prices and book online with Kofi, Dan or Ruby.",
      service_copy: ferdymsCopy,
    },
    image_prompts: {
      hero: promptFor("ferdyms", "hero"),
      logo: "Minimal wordmark logo for FerdyM's Barber Shop, brass lettering on deep green, classic barbershop type, clean and scalable, white background",
      catalog: Object.keys(ferdymsCopy).map((n) => `Close-up photograph of a finished ${n} on an adult man`),
      gallery: [promptFor("ferdyms", "gallery-room"), promptFor("ferdyms", "gallery-tools"), promptFor("ferdyms", "gallery-chair")],
    },
    legal_content: {
      privacy_policy: legal("FerdyM's Barber Shop", "privacy policy"),
      terms_of_service: legal("FerdyM's Barber Shop", "terms of service"),
      cookie_policy: legal("FerdyM's Barber Shop", "cookie policy"),
    },
    social_stubs: socials,
    design_spec: {
      hero: { variant: "full-bleed", motion: "fade" },
      sections: [
        { key: "trust", variant: "icons", include: true },
        { key: "services", variant: "showcase", include: true },
        { key: "team", variant: "cards", include: true },
        { key: "about", variant: "split-image", include: true },
        { key: "how", variant: "grid", include: false },
        { key: "reviews", variant: "marquee", include: true },
        { key: "location", variant: "map-first", include: true },
      ],
      motion: { intensity: "calm", reveal: "fade-up" },
      motif: "line",
      signature: "gallery",
      density: "compact",
    },
  },
  linden: {
    palette: { primary: "#6F7D63", accent: "#2F3A2B", background: "#F6F2EA", text: "#22251F", muted: "#6A6E62" },
    typography: { heading_font: "Cormorant Garamond", body_font: "DM Sans", heading_weight: "600", heading_style: "serif" },
    layout_mood: "warm-editorial",
    brand_voice:
      "Calm, precise and unhurried. Talks plainly about colour and cutting and never sounds like a sales pitch.",
    content: {
      headline: "Soft colour and considered cuts in Clifton",
      subheadline: "A daylight studio in Clifton for lived-in colour, precise cuts and curls, with unhurried appointments.",
      hero_cta: "Book an appointment",
      about_title: "A quiet studio full of daylight",
      about_body:
        "Linden & Lark is a calm, light-filled studio in Clifton where colour and cutting get the time they need. Isla looks after colour and balayage, Priya specialises in precision cutting and curly hair, and Tom takes care of blow-dries and occasion styling. Each appointment starts with a short consultation about what you want and how you wear your hair. We are open Wednesday to Sunday.",
      trust_signals: ["Open Wednesday to Sunday", "Choose from 3 stylists", "7 services, clearly priced"],
      unique_selling_points: [
        "Lived-in colour and balayage with Isla",
        "Precision cuts and curls with Priya",
        "Blow-dries and occasion styling with Tom",
      ],
      seo_title: "Linden & Lark Hair Studio | Hair salon in Clifton, Bristol",
      seo_description:
        "Colour, balayage, cutting and blow-dries in Clifton, Bristol. See prices and book online with Isla, Priya or Tom.",
      service_copy: lindenCopy,
    },
    image_prompts: {
      hero: promptFor("linden", "hero"),
      logo: "Minimal serif wordmark logo for Linden & Lark Hair Studio, deep sage on ivory, a small leaf mark, clean and scalable, white background",
      catalog: Object.keys(lindenCopy).map((n) => `Close-up photograph of a finished ${n} on an adult woman`),
      gallery: [promptFor("linden", "gallery-room"), promptFor("linden", "gallery-basin"), promptFor("linden", "gallery-shelf")],
    },
    legal_content: {
      privacy_policy: legal("Linden & Lark Hair Studio", "privacy policy"),
      terms_of_service: legal("Linden & Lark Hair Studio", "terms of service"),
      cookie_policy: legal("Linden & Lark Hair Studio", "cookie policy"),
    },
    social_stubs: socials,
    design_spec: {
      hero: { variant: "editorial", motion: "fade" },
      sections: [
        { key: "trust", variant: "chips", include: true },
        { key: "about", variant: "story", include: true },
        { key: "services", variant: "rows", include: true },
        { key: "team", variant: "cards", include: true },
        { key: "how", variant: "row", include: true },
        { key: "reviews", variant: "spotlight", include: true },
        { key: "location", variant: "standard", include: true },
      ],
      motion: { intensity: "calm", reveal: "fade-up" },
      motif: "arc",
      signature: null,
      density: "airy",
    },
  },
};

const textFrom = (key, tagline) => {
  const r = RESEARCH[key];
  const copy = key === "ferdyms" ? ferdymsCopy : lindenCopy;
  return {
    headline: r.content.headline,
    tagline,
    about: r.content.about_body,
    services: Object.entries(copy).map(([name, description]) => ({ name, description })),
    seo_title: r.content.seo_title,
    seo_description: r.content.seo_description,
    color_primary: r.palette.primary,
    color_accent: r.palette.accent,
    font_heading: r.typography.heading_font,
    font_body: r.typography.body_font,
  };
};

export const TEXT = {
  ferdyms: textFrom("ferdyms", "Skin fades, scissor cuts and hot towel shaves from three barbers who take their time."),
  linden: textFrom("linden", "Lived-in colour, precise cuts and curls in a calm Clifton studio full of daylight."),
};
