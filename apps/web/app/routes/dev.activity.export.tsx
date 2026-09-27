import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { auditExportErrorHtml, auditQuery } from "~/lib/audit";

/**
 * A refused export (400 "Too many entries; narrow the filters/dates", 404
 * "Subject not found", or the 503 audit-write refusal) must not be handed to
 * the browser as if it were the file: with the upstream's own headers and no
 * Content-Disposition override, a 400/404/503 JSON body would still download
 * as "audit-export.csv"/"audit-proof.json" — a corrupt file the owner can't
 * open. Render it as a plain, readable page instead (no attachment header,
 * so the browser displays it) with the API's own plain-language message and
 * a way back to the list.
 *
 * The message is attacker-influenceable text reflected from the API, so
 * `auditExportErrorHtml` escapes it before interpolation, and this response
 * also carries a restrictive Content-Security-Policy as defence in depth
 * (Ruling 49 — a security check flagged the earlier, unescaped version as an
 * XSS sink).
 */
function errorPage(status: number, message: string): Response {
  return new Response(auditExportErrorHtml(message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": "no-store",
    },
  });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const url = new URL(request.url);
  const token = getSessionToken(request);
  const subject = url.searchParams.get("subject");
  const upstream = subject
    ? `${env.API_URL}/api/audit/subjects/${encodeURIComponent(subject)}/export`
    : `${env.API_URL}/api/audit/export?part=${url.searchParams.get("part") === "proof" ? "proof" : "csv"}${auditQuery(url.searchParams) ? `&${auditQuery(url.searchParams)}` : ""}`;
  const res = await fetch(upstream, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  if (!res.ok) {
    let message = "Something went wrong. Please try again.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // keep the fallback message; the upstream didn't return JSON
    }
    return errorPage(res.status, message);
  }

  const isCsv = (res.headers.get("Content-Type") ?? "").includes("text/csv");
  const filename = subject ? "personal-data-export.json" : isCsv ? "audit-export.csv" : "audit-proof.json";
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
