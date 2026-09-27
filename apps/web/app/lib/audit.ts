export const AUDIT_FILTERS = ["shop_id", "actor", "action", "outcome", "from", "to", "request_id", "cursor"] as const;

export function auditQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of AUDIT_FILTERS) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

/** The two date-range params in isolation. The subject export (unlike the
 *  main list/CSV/proof export) accepts only `from`/`to`, not the full
 *  filter set, so its download link and the export route's subject branch
 *  need just these two rather than the full `auditQuery`. */
export function dateOnlyQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of ["from", "to"] as const) {
    const v = params.get(k);
    if (v) out.set(k, v);
  }
  return out.toString();
}

export function entryStatus(e: { sealed_at: string | null; archived_at: string | null }): {
  label: "Pending" | "Sealed" | "Archived";
  variant: "warning" | "default" | "success";
} {
  if (e.archived_at) return { label: "Archived", variant: "success" };
  if (e.sealed_at) return { label: "Sealed", variant: "default" };
  return { label: "Pending", variant: "warning" };
}

// Every action here is one Plan 1 (apps/worker/src/audit/registry.ts's
// "Instrumented in Plan 1" section, plus the audit trail's own internal
// actions written outside that HTTP-route registry: audit.view/export,
// audit.gap, audit.expire, audit.seal.alert, ai.call, subject.redact,
// data.export) can actually produce today. Anything else falls back to the
// raw action string below. "audit.anchor" is in the fixed catalogue
// (packages/audit/src/actions.ts) but is not emitted by any code yet
// (confirmed: no `action: "audit.anchor"` write site exists) — left out
// rather than labelling something that can't occur, per the brief's own
// "if emitted" condition; it will fall back to its raw name if that changes.
const LABELS: Record<string, string> = {
  "site.activate": "Site made live",
  "site.pause": "Site paused",
  "site.regenerate.request": "Site regeneration requested",
  "theme.generate": "Theme generated",
  "theme.apply": "Theme applied",
  "theme.compare": "Themes compared",
  "shop.delete": "Shop deleted",
  "ai.call": "AI call",
  "ai.chatbot_model.set": "Chatbot model changed",
  "audit.view": "Activity viewed",
  "audit.export": "Activity exported",
  "audit.verify": "Trail checked",
  "audit.gap": "Unlabelled change",
  "audit.expire": "Old entries expired",
  "audit.seal.alert": "Integrity alert",
  "audit.import.historical": "AI history imported",
  "subject.redact": "Personal details blanked",
  "subject.erase_request": "Erasure requested",
  "data.export": "Personal data exported",
};

export function actionLabel(action: string): string {
  return LABELS[action] ?? action;
}

/** Escapes the five HTML-significant characters. The audit export error page
 *  (dev.activity.export.tsx) interpolates the upstream API's `error` message
 *  into hand-built HTML; that message is attacker-influenceable free text
 *  (Ruling 41's shape validation lives on the worker and rejects most bad
 *  input, but a message string itself is never guaranteed HTML-safe), so it
 *  must never be interpolated raw (Ruling 49). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The plain, readable page shown when the export download's upstream fetch
 *  fails (400 "Too many entries…", 404 "Subject not found", the 503 audit
 *  refusal, …) instead of the JSON error body downloading as a corrupt
 *  "audit-export.csv"/"audit-proof.json" file. `message` is escaped before
 *  interpolation (Ruling 49); the route also sends this alongside a
 *  restrictive Content-Security-Policy header and no Content-Disposition. */
export function auditExportErrorHtml(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Export failed</title>
<style>
  body { background: #0D0D0D; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; }
  a { color: #C9A84C; }
</style>
</head>
<body>
<h1>Could not export activity</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/dev/activity">Back to Activity</a></p>
</body>
</html>`;
}

export const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "site.", label: "Website" },
  { value: "theme.", label: "Themes" },
  { value: "shop.", label: "Shops" },
  { value: "ai.", label: "AI" },
  { value: "audit.", label: "Audit trail" },
  { value: "subject.", label: "Personal data" },
];
