/**
 * Refund requests: the gate in front of every discretionary refund.
 *
 * A refund is never issued on one tap. Someone at the shop files a request
 * with a written reason (and optionally an evidence file); the owner or a
 * developer then approves it. Approval IS the refund route: the deposit-cancel
 * and sale-refund routes call `claimRefundRequest` before any money moves and
 * `settleRefundRequest` once they know how it ended.
 *
 * The claim is one guarded UPDATE (pending -> approving), so two approvals of
 * the same request cannot both reach Stripe. A claim left behind by a crashed
 * request is taken over after `STALE_CLAIM_MS`; the refund routes' own guards
 * (deposit claim, returnable quantities, Stripe idempotency keys) stop a
 * second run from paying twice.
 */

export type RefundRequestKind = "deposit" | "sale";

export interface RefundRequestRow {
  id: string;
  shop_id: string;
  kind: RefundRequestKind;
  booking_id: string | null;
  sale_id: string | null;
  lines_json: string | null;
  amount_pence: number;
  reason: string;
  evidence_key: string | null;
  evidence_name: string | null;
  evidence_type: string | null;
  status: "pending" | "approving" | "approved" | "declined";
  requested_by: string;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  refunded_pence: number | null;
}

export interface RefundLine {
  sale_item_id: string;
  quantity: number;
  restock?: boolean;
}

export const REASON_MIN = 10;
export const REASON_MAX = 1000;
export const NOTE_MAX = 500;
const STALE_CLAIM_MS = 10 * 60 * 1000;

export const REQUEST_REQUIRED_MESSAGE =
  "A refund needs an approved refund request. File a request with the reason, then have the owner approve it.";

/** The stored evidence object key for a shop: nothing else may be attached. */
export function evidencePrefix(shopId: string): string {
  return `refund-evidence/${shopId}/`;
}

export function parseRefundLines(raw: string | null): RefundLine[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((l): RefundLine[] => {
      if (!l || typeof l !== "object") return [];
      const o = l as Record<string, unknown>;
      if (typeof o.sale_item_id !== "string" || typeof o.quantity !== "number") return [];
      return [{ sale_item_id: o.sale_item_id, quantity: o.quantity, ...(o.restock === false ? { restock: false } : {}) }];
    });
  } catch {
    return [];
  }
}

export async function getRefundRequest(
  db: D1Database,
  shopId: string,
  requestId: string
): Promise<RefundRequestRow | null> {
  return db
    .prepare("SELECT * FROM refund_requests WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(requestId, shopId)
    .first<RefundRequestRow>();
}

export type ClaimResult =
  | { ok: true; request: RefundRequestRow }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Claim a pending request for the refund about to run. `targetId` is the
 * booking (deposit) or sale the route is acting on: a request filed for one
 * thing can never approve a refund of another.
 */
export async function claimRefundRequest(
  db: D1Database,
  args: { shopId: string; requestId: string; kind: RefundRequestKind; targetId: string; now?: Date }
): Promise<ClaimResult> {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const column = args.kind === "deposit" ? "booking_id" : "sale_id";
  const claim = await db
    .prepare(
      `UPDATE refund_requests SET status = 'approving', reviewed_at = ?1
       WHERE id = ?2 AND shop_id = ?3 AND kind = ?4 AND ${column} = ?5
         AND (status = 'pending' OR (status = 'approving' AND reviewed_at < ?6))`
    )
    .bind(nowIso, args.requestId, args.shopId, args.kind, args.targetId, staleBefore)
    .run();
  const request = await getRefundRequest(db, args.shopId, args.requestId);
  if ((claim.meta?.changes ?? 0) === 1 && request) return { ok: true, request };
  if (!request || request.kind !== args.kind || request[column] !== args.targetId) {
    return { ok: false, status: 404, error: "Refund request not found" };
  }
  if (request.status === "approved") {
    return { ok: false, status: 409, error: "This refund request was already approved" };
  }
  if (request.status === "declined") {
    return { ok: false, status: 409, error: "This refund request was declined" };
  }
  return { ok: false, status: 409, error: "This refund request is being approved by someone else. Reload and check." };
}

/**
 * End a claim. `refundedPence` set: the refund went through and the request is
 * approved by `reviewerId`. Null: nothing was refunded and the request goes
 * back to pending for another try.
 */
export async function settleRefundRequest(
  db: D1Database,
  args: { requestId: string; reviewerId: string; refundedPence: number | null; now?: Date }
): Promise<void> {
  if (args.refundedPence === null) {
    await db
      .prepare("UPDATE refund_requests SET status = 'pending', reviewed_at = NULL WHERE id = ? AND status = 'approving'")
      .bind(args.requestId)
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE refund_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, refunded_pence = ?
       WHERE id = ? AND status = 'approving'`
    )
    .bind(args.reviewerId, (args.now ?? new Date()).toISOString(), args.refundedPence, args.requestId)
    .run();
}
