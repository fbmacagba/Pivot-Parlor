/**
 * Code-owned registry of the public portfolio demonstrations.
 *
 * A demo is a FICTIONAL shop whose records live in the database under a fixed,
 * code-owned shop id and are generated through the normal site pipeline. The
 * public pages render that generated output; this registry only adds the
 * safety layer (no real bookings, payments, queue entries or emails; scripted
 * assistant replies; one consolidated disclosure).
 *
 * Membership is decided here, never by a request flag. An alias slug (an
 * already-published URL) always loads its fictional backing shop BY ID, so it
 * can never fall through to a real tenant that happens to hold that slug.
 *
 * Collision safety: public lookups try slug before id, but every slug the
 * platform mints ends in "-<shop number>" (shops.post: toSlug(base) + "-NNN"),
 * so no created shop can take a backing id ("pp-demo-...") or a backing slug
 * ("...-demo") listed here.
 */
export interface PortfolioDemo {
  /** Fixed id of the fictional backing shop (code-owned, never user-created). */
  shopId: string;
  /** The backing shop's own slug. */
  slug: string;
  /** Previously published public slugs that render this demo. */
  aliases: readonly string[];
  /** Plain category label used in titles and disclosure copy. */
  kind: string;
}

export const PORTFOLIO_DEMOS: readonly PortfolioDemo[] = [
  {
    shopId: "pp-demo-ferdyms-barber",
    slug: "ferdyms-barber-shop-demo",
    // The original public demo URL. In production a real (test) tenant holds
    // this slug; the alias makes the URL render the fictional backing shop
    // instead, and the guards below keep that tenant refusing public writes.
    aliases: ["ferdyms-barber-shop-014"],
    kind: "barber shop",
  },
  {
    shopId: "pp-demo-linden-lark",
    slug: "linden-and-lark-demo",
    aliases: [],
    kind: "hair salon",
  },
];

/** @deprecated kept for existing imports: the original public demo URL. */
export const PORTFOLIO_DEMO_SLUG = "ferdyms-barber-shop-014";
/** @deprecated kept for existing imports: the barber demo's backing shop id. */
export const PORTFOLIO_DEMO_ID = "pp-demo-ferdyms-barber";

export const PORTFOLIO_DEMO_ERROR =
  "This demonstration shop does not accept real bookings, payments or queue submissions.";

/** The demo a public slug renders (its own slug or an alias), else null. */
export function portfolioDemoForSlug(slug: string | null | undefined): PortfolioDemo | null {
  if (typeof slug !== "string" || slug.length === 0) return null;
  return PORTFOLIO_DEMOS.find((d) => d.slug === slug || d.aliases.includes(slug)) ?? null;
}

/** True when this public slug renders a portfolio demo. Exact match only. */
export function isPortfolioDemoShop(slug: string | null | undefined): boolean {
  return portfolioDemoForSlug(slug) !== null;
}

/** Server-side guard on a RESOLVED shop row: matches the fictional backing id,
 *  the backing slug, or an alias slug (so a real tenant still holding an alias
 *  keeps refusing public writes, whichever identifier a caller used). */
export function isPortfolioDemoShopRecord(
  shop: { id?: string | null; slug?: string | null } | null | undefined,
): boolean {
  if (!shop) return false;
  if (typeof shop.id === "string" && PORTFOLIO_DEMOS.some((d) => d.shopId === shop.id)) return true;
  return isPortfolioDemoShop(shop.slug);
}

/** The key public loaders use to read a shop's records: always the fictional
 *  backing shop id for a demo slug, otherwise the slug itself. */
export function shopDataKeyForSlug(slug: string): string {
  return portfolioDemoForSlug(slug)?.shopId ?? slug;
}

/** Fictional UK numbers in Ofcom's drama ranges (London 020 7946 0xxx,
 *  Bristol 0117 496 0xxx) are the only phone numbers a demo may show. */
export function isIllustrativePhone(value: string | null | undefined): boolean {
  if (!value) return false;
  const digits = value.replace(/\D/g, "").replace(/^44/, "0");
  return /^02079460\d{3}$/.test(digits) || /^01174960\d{3}$/.test(digits);
}

export interface DemoReplyContext {
  shopName: string;
  services: Array<{ name: string; price_gbp: number; duration_minutes: number; description?: string }>;
  staff: Array<{ display_name: string; speciality?: string | null }>;
}

function money(gbp: number): string {
  return Number.isInteger(gbp) ? `£${gbp}` : `£${gbp.toFixed(2)}`;
}

/** Explicitly scripted sample replies built from the services and team the
 *  page itself renders, so chat, site and booking never disagree. No model,
 *  network call or storage. */
export function portfolioDemoReply(message: string, ctx: DemoReplyContext): string {
  const services = ctx.services.slice(0, 6);
  const team = ctx.staff.slice(0, 6);
  const lower = message.toLowerCase();
  // A named service (the welcome chips send "Tell me about <name>"): longest
  // name first so "Cut & beard" wins over "Cut".
  const named = [...ctx.services]
    .sort((a, b) => b.name.length - a.name.length)
    .find((s) => s.name.trim() && lower.includes(s.name.toLowerCase()));
  if (named) {
    const time = named.duration_minutes > 0 ? `, ${named.duration_minutes} minutes` : "";
    const about = named.description?.trim() ? ` ${named.description.trim()}` : "";
    return `${named.name}: ${money(named.price_gbp)}${time}.${about} You can choose it in the demo booking; nothing is reserved.`;
  }
  if (/staff|barber|stylist|team|who|book with/i.test(message) && team.length > 0) {
    const list = team
      .map((m) => (m.speciality ? `${m.display_name} (${m.speciality})` : m.display_name))
      .join(", ");
    return `The fictional team is ${list}. You can pick any of them in the demo booking.`;
  }
  if (/price|cost|how much|service|menu|cut|fade|beard|shave|colour|color|blow|treatment/i.test(message) && services.length > 0) {
    const list = services.map((s) => `${s.name} ${money(s.price_gbp)} (${s.duration_minutes} min)`).join("; ");
    return `Here is the sample menu: ${list}. Try the demo booking to see the next steps. Nothing is reserved.`;
  }
  if (/time|slot|book|available|appointment|open|hour/i.test(message)) {
    return "Choose a service, a team member and a date in the demo booking. The times are sample times and completing the walkthrough reserves nothing.";
  }
  return `This is a scripted sample assistant for ${ctx.shopName}, a fictional demo shop. Ask about the services, prices or team, or try the demo booking. Please do not enter personal details.`;
}
