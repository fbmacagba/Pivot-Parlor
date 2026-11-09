import type { AuditAction } from "@repo/audit";

/**
 * Every mutating route of the chatbot app and the audit action it records.
 * `GET /health` is read-only and is not declared. The platform referral reply,
 * validation errors (400), unknown shops (404), Turnstile refusals (403) and
 * rate limits (429) call no model and write no entry.
 */
export const ROUTE_AUDIT: Record<string, AuditAction> = {
  "POST /chat": "ai.call",
};
