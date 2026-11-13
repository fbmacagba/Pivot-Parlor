/**
 * Length caps for the public contact form. The API enforces them
 * (apps/worker/src/routes/contact.ts) and the website's inputs carry them as
 * maxlength (apps/web/app/routes/_marketing.contact.tsx), so a visitor meets
 * the same limit in the browser that the API applies.
 */
export const CONTACT_FIELD_LIMITS = {
  full_name: 120,
  shop_name: 120,
  email: 254,
  phone: 40,
  message: 2000,
} as const;

export type ContactLimitedField = keyof typeof CONTACT_FIELD_LIMITS;

/**
 * Each line break as one "\n". A browser's maxlength counts a textarea line
 * break as one character but submits it as CRLF, so without this a message
 * the form accepted could measure longer at the API than in the browser.
 */
export function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
