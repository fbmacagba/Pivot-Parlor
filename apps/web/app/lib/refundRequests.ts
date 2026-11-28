/**
 * Refund review. No refund goes out on one tap: someone at the shop files a
 * request with a written reason and, if they have it, an evidence file; the
 * owner then approves or declines it on the Refunds page. Approval is what
 * moves the money.
 */

/** The shortest reason the API takes: enough to say what happened. */
export const REFUND_REASON_MIN = 10;
export const REFUND_REASON_MAX = 1000;
export const REFUND_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const REFUND_EVIDENCE_ACCEPT = "image/png,image/jpeg,image/webp,application/pdf";

export interface RefundRequest {
  id: string;
  kind: "deposit" | "sale";
  booking_id: string | null;
  sale_id: string | null;
  amount_pence: number;
  reason: string;
  has_evidence: boolean;
  evidence_name: string | null;
  status: "pending" | "approved" | "declined";
  /** The user id of whoever filed it. */
  requested_by?: string | null;
  requested_by_name: string | null;
  requested_at: string;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  refunded_pence: number | null;
  customer_name: string | null;
  booking_date: string | null;
  start_time: string | null;
  sale_created_at: string | null;
  sale_tender_type: string | null;
  /** The shop cancelled the booking: the refund its terms promise. */
  shop_cancelled?: boolean;
}

/**
 * Nobody approves their own request on their word alone: whoever filed a
 * request may approve it only when it carries evidence. The booking worker
 * enforces this; the page uses it to say so before the tap. A shop
 * cancellation is the exception: that refund is owed under the shop's terms.
 */
export function selfApprovalBlocked(
  request: Pick<RefundRequest, "requested_by" | "has_evidence" | "shop_cancelled">,
  userId: string
): boolean {
  if (request.shop_cancelled) return false;
  return request.requested_by === userId && !request.has_evidence;
}

/** Why a reason cannot be sent yet, or null when it can. */
export function refundReasonProblem(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REFUND_REASON_MIN) return `Say what happened, in at least ${REFUND_REASON_MIN} characters.`;
  if (length > REFUND_REASON_MAX) return `Keep the reason under ${REFUND_REASON_MAX} characters.`;
  return null;
}

/** Why a file cannot be attached, or null when it can (or there is none). */
export function refundEvidenceProblem(file: { size: number; type: string } | null): string | null {
  if (!file || file.size === 0) return null;
  if (!REFUND_EVIDENCE_ACCEPT.split(",").includes(file.type)) {
    return "Attach a PNG, JPEG or WebP image, or a PDF.";
  }
  if (file.size > REFUND_EVIDENCE_MAX_BYTES) return "That file is over 5MB. Attach a smaller one.";
  return null;
}

/** The evidence file a form carried, or null when none was chosen. */
export function evidenceFrom(form: FormData): File | null {
  const value = form.get("evidence");
  return value instanceof File && value.size > 0 ? value : null;
}

/**
 * File a refund request with the API (server side). The reason and the file
 * travel as a form, since the file cannot ride in JSON. Throws an Error with
 * the API's own message when the request is refused.
 */
export async function fileRefundRequest(
  apiUrl: string,
  token: string,
  shopId: string,
  fields:
    | { kind: "deposit"; booking_id: string; reason: string }
    // The shop itself is cancelling: no reason to write, the server records it.
    | { kind: "deposit"; booking_id: string; shop_cancelled: true }
    | { kind: "sale"; sale_id: string; lines: unknown; reason: string },
  evidence: File | null
): Promise<{ id: string; amount_pence: number }> {
  const form = new FormData();
  form.set("kind", fields.kind);
  if ("shop_cancelled" in fields) form.set("shop_cancelled", "1");
  else form.set("reason", fields.reason);
  if (fields.kind === "deposit") {
    form.set("booking_id", fields.booking_id);
  } else {
    form.set("sale_id", fields.sale_id);
    form.set("lines", JSON.stringify(fields.lines));
  }
  if (evidence) form.set("evidence", evidence, evidence.name);

  const res = await fetch(`${apiUrl}/api/shops/${encodeURIComponent(shopId)}/refund-requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  type Answer = { success?: boolean; data?: { id: string; amount_pence: number }; error?: string };
  const payload = (await res.json().catch(() => null)) as Answer | null;
  if (!res.ok || !payload?.data) {
    throw Object.assign(new Error(payload?.error ?? `HTTP ${res.status}`), { status: res.status });
  }
  return payload.data;
}

/** A refund request id, safe to put in an API path. */
const REFUND_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The `add_evidence` form intent, shared by the pages that list requests
 * (server side): attach the posted file to a waiting request that has none.
 * The API decides whether it may be attached (once, by whoever filed the
 * request or the owner).
 */
export async function addEvidenceFromForm(
  apiUrl: string,
  token: string,
  shopId: string,
  form: FormData
): Promise<{ status: number; body: { ok: true; message: string } | { error: string } }> {
  const requestId = String(form.get("requestId") ?? "").trim();
  if (!REFUND_REQUEST_ID.test(requestId)) return { status: 400, body: { error: "Missing refund request." } };
  const evidence = evidenceFrom(form);
  if (!evidence) return { status: 400, body: { error: "Choose a file to attach." } };
  const problem = refundEvidenceProblem(evidence);
  if (problem) return { status: 400, body: { error: problem } };

  const send = new FormData();
  send.set("evidence", evidence, evidence.name);
  const res = await fetch(
    `${apiUrl}/api/shops/${encodeURIComponent(shopId)}/refund-requests/${requestId}/evidence`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: send }
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    return { status: 400, body: { error: payload?.error ?? "The file could not be attached." } };
  }
  return { status: 200, body: { ok: true, message: "Evidence attached to the request." } };
}
