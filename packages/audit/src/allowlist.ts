/** Fields that may appear in changes_json, per entity type (spec 4.3). */
export const CHANGE_ALLOWLIST: Record<string, readonly string[]> = {
  // headline and tagline are deliberately excluded (Ruling 21, same data
  // class as Ruling 20 below): no Plan-1 caller logs them, and both are
  // generated/free-form copy that can carry the shop name (personal data).
  shop_site: ["website_status", "template"],
  // name, slug and phone are deliberately excluded (Ruling 17): they are
  // personal data (sole traders trade under their own name). Record their
  // field names in details.fields instead.
  shop: ["type", "plan", "status", "is_active", "commission_rate", "retail_commission_rate", "stripe_payment_status",
    "setup_completed", "operational_status", "stripe_connect_onboarded"],
  // heroHeadline and tagline are deliberately excluded (Ruling 20): generated
  // copy routinely carries the shop name (personal data) and, applied via
  // /apply-theme, is unbounded client text — both locked forever once hashed.
  theme: ["ai_model", "primaryColor", "accentColor", "fontHeading", "fontBody"],
  platform_setting: ["chatbot_model"],
  generation_job: ["status", "text_model", "image_model", "skip_images", "composer", "template"],
  audit_subject: ["redact_after"],
  // Plan 2. Only structured fields: a person's name, email, phone, notes, bio
  // or any free text never appears here (record the field name instead).
  service: ["name", "duration_min", "price_pence", "category", "is_active"],
  staff: ["is_active"],
  schedule: [], // details only
  product: [
    "name", "sku", "category_id", "supplier_id", "cost_price_pence", "retail_price_pence",
    "tax_rate_bps", "is_professional", "track_stock", "is_active",
  ],
  product_variant: ["name", "sku", "cost_price_pence", "retail_price_pence", "is_active"],
  product_category: ["name", "sort_order", "is_active"],
  supplier: ["is_active"],
  stock_movement: ["product_id", "variant_id", "type", "quantity_delta", "unit_cost_pence"],
  stock_level: ["reorder_point", "reorder_qty"],
  purchase_order: ["status", "supplier_id"],
  stock_take: ["status"],
  booking: ["status"],
  walkin_entry: ["status"],
  waitlist_entry: ["status"],
  review: ["rating"],
  shop_setting: [
    "booking_enabled", "booking_confirmation_email", "booking_reminder_email", "reminder_hours_before",
    "review_request_email", "deposits_enabled", "deposit_percent", "deposit_min_pence",
    "show_instagram", "show_facebook", "show_tiktok", "show_twitter", "show_youtube", "show_whatsapp",
    "show_linkedin", "show_google_business",
  ],
  platform_user: ["role", "email_verified"],
  // Plan 3 (booking worker): statuses and flags only.
  business_day: ["status"],
  sale: ["status"],
  platform_alert: ["resolved"],
};

export function filterChanges(
  entityType: string | null | undefined,
  changes: Record<string, [unknown, unknown]> | null | undefined
): Record<string, [unknown, unknown]> | null {
  if (!changes || !entityType) return null;
  const allowed = CHANGE_ALLOWLIST[entityType];
  if (!allowed) return null;
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of allowed) if (k in changes) out[k] = changes[k]!;
  return Object.keys(out).length > 0 ? out : null;
}
