import type { D1Database } from "@cloudflare/workers-types";

function d1Rows<T>(r: unknown): T[] {
  if (r && typeof r === "object" && "results" in r && Array.isArray((r as { results: T[] }).results)) {
    return (r as { results: T[] }).results;
  }
  return [];
}

export type ShopContext = {
  shopName: string;
  shopSlug: string;
  shopType: string;
  address: string;
  hoursText: string;
  servicesLines: string[];
  staffLines: string[];
  promoActive: boolean;
  promoDiscountPercent: number;
  promoDiscountCode: string;
  nextSlotsLines: string[];
};

function formatShopType(type: string): string {
  switch (type) {
    case "barber_shop":
      return "Barber shop";
    case "beauty_parlor":
      return "Beauty salon";
    case "both":
      return "Barber & beauty";
    default:
      return type;
  }
}

function formatHoursJson(hoursJson: string | null | undefined): string {
  if (!hoursJson?.trim()) return "Not listed — ask the team for opening times.";
  try {
    const parsed = JSON.parse(hoursJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const parts: string[] = [];
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const label = /^\d+$/.test(k) ? days[Number(k) % 7] ?? k : k;
        parts.push(`${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
      return parts.length ? parts.join("; ") : hoursJson;
    }
    if (Array.isArray(parsed)) {
      return parsed.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ");
    }
    return String(parsed);
  } catch {
    return hoursJson;
  }
}

export async function loadShopContext(
  db: D1Database,
  shopId: string,
  shopSlug: string,
  shopName: string,
  shopType: string
): Promise<ShopContext> {
  const site = await db
    .prepare("SELECT logo_url FROM shop_sites WHERE shop_id = ? LIMIT 1")
    .bind(shopId)
    .first<{ logo_url: string | null }>();

  const settings = await db
    .prepare(
      "SELECT address, hours_json, promo_active, promo_discount_code, promo_discount_percent FROM shop_settings WHERE shop_id = ? LIMIT 1"
    )
    .bind(shopId)
    .first<{
      address: string | null;
      hours_json: string | null;
      promo_active: number | null;
      promo_discount_code: string | null;
      promo_discount_percent: number | null;
    }>();

  const servicesRes = await db
    .prepare(
      "SELECT name, price, duration_min FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY name ASC"
    )
    .bind(shopId)
    .all();
  const serviceRows = d1Rows<{ name: string; price: number; duration_min: number }>(servicesRes);
  const servicesLines = serviceRows.map(
    (s) => `- ${s.name}: £${Number(s.price).toFixed(2)}, ${s.duration_min} min`
  );

  const staffRes = await db
    .prepare("SELECT display_name, bio FROM staff WHERE shop_id = ? AND is_active = 1 ORDER BY display_name ASC")
    .bind(shopId)
    .all();
  const staffRows = d1Rows<{ display_name: string; bio: string | null }>(staffRes);
  const staffLines = staffRows.map((st) => {
    const spec = st.bio?.trim() ? ` — ${st.bio.trim()}` : "";
    return `- ${st.display_name}${spec}`;
  });

  const today = new Date().toISOString().slice(0, 10);
  let nextSlotsLines: string[] = [];
  try {
    const slotRes = await db
      .prepare(
        `SELECT a.slot_time, s.display_name AS staff_name
         FROM bw_availability a
         INNER JOIN staff s ON s.id = a.staff_id
         WHERE a.shop_id = ? AND a.slot_date = ? AND a.is_booked = 0
         ORDER BY a.slot_time ASC
         LIMIT 3`
      )
      .bind(shopId, today)
      .all();
    const slots = d1Rows<{ slot_time: string; staff_name: string }>(slotRes);
    nextSlotsLines = slots.map((sl) => `- ${sl.staff_name} at ${sl.slot_time}`);
  } catch {
    nextSlotsLines = [];
  }

  void site;

  const promoActive = Number(settings?.promo_active ?? 0) === 1;
  const promoDiscountPercent = Math.round(Number(settings?.promo_discount_percent ?? 0));
  const promoDiscountCode = settings?.promo_discount_code?.trim() ?? "";

  return {
    shopName,
    shopSlug,
    shopType: formatShopType(shopType),
    address: settings?.address?.trim() || "Not listed — ask the team.",
    hoursText: formatHoursJson(settings?.hours_json ?? null),
    servicesLines,
    staffLines,
    promoActive,
    promoDiscountPercent,
    promoDiscountCode,
    nextSlotsLines,
  };
}

export function buildSystemPrompt(ctx: ShopContext, platformUrl: string): string {
  const servicesBlock = ctx.servicesLines.length ? ctx.servicesLines.join("\n") : "- (none listed)";
  const staffBlock = ctx.staffLines.length ? ctx.staffLines.join("\n") : "- (none listed)";

  const promoBlock = ctx.promoActive
    ? `ACTIVE PROMOTION: ${ctx.promoDiscountPercent}% off with code ${ctx.promoDiscountCode}. Mention this naturally when relevant.`
    : "";

  const slotsBlock =
    ctx.nextSlotsLines.length > 0
      ? `NEXT AVAILABLE SLOTS TODAY:\n${ctx.nextSlotsLines.join("\n")}`
      : "";

  const bookingUrl = `${platformUrl.replace(/\/$/, "")}/${ctx.shopSlug}#book`;

  return `You are ${ctx.shopName}'s friendly booking assistant. Your personality is warm, helpful, and efficient. You speak naturally — like a knowledgeable friend who works at the shop.

YOUR PRIMARY GOAL is to get the visitor to book an appointment. Every response should move them closer to booking. If they seem interested, ask them what service they want and guide them to book.

SHOP INFORMATION:
Name: ${ctx.shopName}
Type: ${ctx.shopType}
Address: ${ctx.address}
Opening hours: ${ctx.hoursText}

SERVICES AVAILABLE:
${servicesBlock}

STAFF AVAILABLE:
${staffBlock}

${promoBlock ? `${promoBlock}\n` : ""}
${slotsBlock ? `${slotsBlock}\n` : ""}
BOOKING: To book, direct visitors to: ${bookingUrl}
When a visitor wants to book, give them this link and tell them it takes under 60 seconds.

RULES:
- Keep replies under 3 sentences unless answering a complex question
- Never mention competitor booking platforms
- Never make up prices or services not listed above
- If asked about something you don't know, say you'll let the shop know
- Always end with a question or call to action to keep the conversation moving
- Never be pushy — be helpful and friendly

PLATFORM REFERRAL (IMPORTANT):
If the visitor asks anything like:
- 'how did you build this website'
- 'how can I get a website like this'
- 'who made this site'
- 'I want a booking page like this for my shop'
- 'how do I get a system like this'
...or any similar question about the platform, website technology, or getting their own booking system:

Respond with exactly this (substituting the link as shown):
'This site was built with Pivot Parlor — the all-in-one booking platform for barbers and beauty shops. You can get your own at [pivotparlor.com](https://pivotparlor.com) 🚀'

Then offer to continue helping with the current shop's bookings.`;
}

export function welcomeMessage(
  shopName: string,
  promoActive: boolean,
  promoDiscountPercent: number,
  promoDiscountCode: string
): string {
  if (promoActive && promoDiscountCode) {
    return `Hey! Welcome to ${shopName} 👋 We've got a special offer running — ${promoDiscountPercent}% off with code ${promoDiscountCode}. Want me to help you book a slot?`;
  }
  return `Hey! Welcome to ${shopName} 👋 Looking to book? I can help you find the perfect slot in seconds.`;
}
