/** Fields that may appear in changes_json, per entity type (spec 4.3). */
export const CHANGE_ALLOWLIST: Record<string, readonly string[]> = {
  // headline and tagline are deliberately excluded (Ruling 21, same data
  // class as Ruling 20 below): no Plan-1 caller logs them, and both are
  // generated/free-form copy that can carry the shop name (personal data).
  shop_site: ["website_status", "template"],
  shop: ["name", "slug", "type", "phone", "status", "is_active", "ai_model"],
  // heroHeadline and tagline are deliberately excluded (Ruling 20): generated
  // copy routinely carries the shop name (personal data) and, applied via
  // /apply-theme, is unbounded client text — both locked forever once hashed.
  theme: ["ai_model", "primaryColor", "accentColor", "fontHeading", "fontBody"],
  platform_setting: ["chatbot_model"],
  generation_job: ["status", "text_model", "image_model", "skip_images", "composer", "template"],
  audit_subject: ["redact_after"],
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
