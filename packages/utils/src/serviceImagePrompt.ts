/**
 * Subject phrase for AI service/hero imagery, chosen by shop type so a barber
 * shop shows men and a beauty parlor shows women (leaving the subject
 * unspecified produced e.g. all-female service photos on a barber shop).
 * "both" / unknown stays neutral. Mirrors the research worker's
 * catalogSubjectFor (PR #104) — keep the two byte-identical.
 */
export function catalogSubjectFor(shopType: string): string {
  if (shopType === "barber_shop") return "a male client";
  if (shopType === "beauty_parlor") return "a female client";
  return "a client";
}

/**
 * Deterministic per-service catalog image prompt. This is the SAME template the
 * research worker builds catalog[] from, so a developer regenerating one service
 * photo gets a result consistent with a full-site regenerate.
 */
export function buildServiceImagePrompt(serviceName: string, shopType: string): string {
  const subject = catalogSubjectFor(shopType);
  return `Photorealistic close-up of the finished ${serviceName} result on ${subject}, flattering professional lighting, square format`;
}
