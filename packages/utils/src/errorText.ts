/**
 * An error message made safe to send to an alert: emails, ids, tokens and long
 * numbers are replaced with placeholders, whitespace is collapsed, and the text
 * is cut to `max` characters. Used on both sides of the website's server-error
 * report (apps/web/app/lib/serverErrors.ts and apps/worker/src/web-errors.ts),
 * so a value one side misses the other still catches.
 */
export function scrubErrorText(text: string, max = 300): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    // JWT-shaped: three dot-separated base64url segments.
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "<token>")
    // Any long run of letters and digits together (session ids, API keys, hashes).
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "<token>")
    .replace(/\d{6,}/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
