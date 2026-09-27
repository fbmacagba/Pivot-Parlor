/** Fields that may appear in changes_json, per entity type (spec 4.3). */
export const CHANGE_ALLOWLIST: Record<string, readonly string[]> = {
  shop_site: ["website_status", "template", "headline", "tagline"],
  shop: ["name", "slug", "type", "phone", "status", "is_active", "ai_model"],
  theme: ["ai_model", "primaryColor", "accentColor", "fontHeading", "fontBody", "heroHeadline", "tagline"],
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
