/**
 * Refund requests: file, list, decline.
 *
 * Mounted under /booking/shops (auth + requireShopAccess: developer, or the
 * shop's own admin/staff). Anyone at the shop may FILE a request; only the
 * owner (admin) or a developer may decline one. There is no approve route
 * here on purpose: approval is the refund itself (the deposit-cancel and
 * sale-refund routes), which act only on a pending request and mark it
 * approved once the money has actually gone back.
 */
import { Hono } from "hono";
import type { Env } from "../types.js";
import { getUser } from "../middleware/auth.js";
import { shopExists } from "../middleware/shop-access.js";
import { readJsonObject } from "@repo/utils";
import { AuditWriteError } from "@repo/audit";
import { auditFor, auditRefused, statusOutcome } from "../audit/context.js";
import { priceSaleRefund } from "./sales.js";
import {
  NOTE_MAX,
  REASON_MAX,
  REASON_MIN,
  SHOP_CANCELLED_REASON,
  evidencePrefix,
  type RefundLine,
} from "../lib/refund-requests.js";

const r = new Hono<{ Bindings: Env }>();

const STAFF_OWN_BOOKINGS_ONLY = "You can only ask for a deposit refund on your own bookings.";

/**
 * The deposit a booking still holds that could be refunded, in pence, or why
 * there is none. The same reading the deposit-cancel route takes before it
 * refunds: a captured deposit, not credited to a sale, not already refunded.
 */
async function refundableDeposit(
  db: D1Database,
  shopId: string,
  bookingId: string
): Promise<{ ok: true; pence: number; bookingStatus: string } | { ok: false; status: 400 | 404; error: string }> {
  const booking = await db
    .prepare("SELECT status FROM bookings WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(bookingId, shopId)
    .first<{ status: string }>();
  if (!booking) return { ok: false, status: 404, error: "Booking not found" };
  if (booking.status === "completed" || booking.status === "no_show") {
    return { ok: false, status: 400, error: "A deposit on a closed booking cannot be refunded here" };
  }
  const st = await db
    .prepare(
      `SELECT stripe_payment_intent_id, deposit_paid_at, deposit_amount_pence
       FROM bw_booking_state WHERE booking_id = ? AND shop_id = ? LIMIT 1`
    )
    .bind(bookingId, shopId)
    .first<{ stripe_payment_intent_id: string | null; deposit_paid_at: string | null; deposit_amount_pence: number | null }>();
  const depositTx = await db
    .prepare("SELECT status, sale_id FROM bw_transactions WHERE booking_id = ? AND type = 'deposit' LIMIT 1")
    .bind(bookingId)
    .first<{ status: string; sale_id: string | null }>();
  const refundTx = await db
    .prepare("SELECT id FROM bw_transactions WHERE booking_id = ? AND type = 'refund' LIMIT 1")
    .bind(bookingId)
    .first<{ id: string }>();
  if (refundTx || depositTx?.status === "refunded") {
    return { ok: false, status: 400, error: "Deposit already refunded" };
  }
  const pence = Number(st?.deposit_amount_pence ?? 0);
  const charged =
    Boolean(st?.deposit_paid_at) &&
    Boolean(st?.stripe_payment_intent_id?.trim()) &&
    depositTx?.status === "captured" &&
    !depositTx.sale_id &&
    pence > 0;
  if (!charged) return { ok: false, status: 400, error: "This booking has no deposit that can be refunded" };
  return { ok: true, pence, bookingStatus: booking.status };
}

// ─── POST /:shopId/refund-requests — file a request ──────────────────────────

r.post("/:shopId/refund-requests", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  const user = getUser(c);
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }

  const body = await readJsonObject<{
    kind?: string;
    booking_id?: string;
    sale_id?: string;
    lines?: Array<{ sale_item_id?: string; quantity?: number; restock?: boolean }>;
    reason?: string;
    evidence_key?: string;
    evidence_name?: string;
    evidence_type?: string;
    shop_cancelled?: boolean | string;
  }>(c.req);
  if (!body) return c.json({ success: false, error: "Invalid JSON" }, 400);

  const kind = body.kind;
  if (kind !== "deposit" && kind !== "sale") {
    return c.json({ success: false, error: "kind must be deposit or sale" }, 400);
  }
  // A shop cancellation: the shop is cancelling the booking itself, and its
  // terms promise that refund. Only someone who can cancel for the shop may
  // say so, and only about a deposit.
  const shopCancelled = body.shop_cancelled === true || body.shop_cancelled === "1";
  if (shopCancelled) {
    if (user.role !== "admin" && user.role !== "developer") {
      return c.json({ success: false, error: "Only the owner can cancel a booking as the shop" }, 403);
    }
    if (kind !== "deposit") {
      return c.json({ success: false, error: "Only a booking deposit can be refunded as a shop cancellation" }, 400);
    }
  }
  const written = typeof body.reason === "string" ? body.reason.trim() : "";
  const reason = shopCancelled && written.length === 0 ? SHOP_CANCELLED_REASON : written;
  if (reason.length < REASON_MIN) {
    return c.json(
      { success: false, error: `Say why this refund is due, in at least ${REASON_MIN} characters.` },
      400
    );
  }
  if (reason.length > REASON_MAX) {
    return c.json({ success: false, error: `The reason can be at most ${REASON_MAX} characters.` }, 400);
  }

  // An evidence file is stored by the API worker before it forwards here; the
  // key must sit under this shop's evidence folder, so a request can never
  // point at another shop's file or at anything else in the bucket.
  let evidenceKey: string | null = null;
  if (typeof body.evidence_key === "string" && body.evidence_key.length > 0) {
    if (!body.evidence_key.startsWith(evidencePrefix(shopId)) || body.evidence_key.includes("..")) {
      return c.json({ success: false, error: "Invalid evidence file" }, 400);
    }
    // The key alone proves nothing: this worker can be called directly, so
    // the file it names must really be in the bucket. Evidence that is not
    // there would let someone approve their own request on a made-up name.
    if (!(await c.env.AUDIT_ARCHIVE.head(body.evidence_key))) {
      return c.json({ success: false, error: "Invalid evidence file" }, 400);
    }
    evidenceKey = body.evidence_key;
  }
  const evidenceName = evidenceKey && typeof body.evidence_name === "string" ? body.evidence_name.slice(0, 200) : null;
  const evidenceType = evidenceKey && typeof body.evidence_type === "string" ? body.evidence_type.slice(0, 100) : null;

  let targetId: string;
  let amountPence: number;
  let linesJson: string | null = null;
  if (kind === "deposit") {
    targetId = typeof body.booking_id === "string" ? body.booking_id : "";
    if (!targetId) return c.json({ success: false, error: "booking_id is required" }, 400);
    // Staff ask only about bookings that are their own. (A booking that does
    // not exist falls through to the 404 below.)
    if (user.role === "staff") {
      const mine = await db
        .prepare(
          `SELECT st.user_id FROM bookings b
           LEFT JOIN staff st ON st.id = b.staff_id AND st.shop_id = b.shop_id AND st.is_active = 1
           WHERE b.id = ? AND b.shop_id = ? LIMIT 1`
        )
        .bind(targetId, shopId)
        .first<{ user_id: string | null }>();
      if (mine && mine.user_id !== user.sub) {
        return c.json({ success: false, error: STAFF_OWN_BOOKINGS_ONLY }, 403);
      }
    }
    const deposit = await refundableDeposit(db, shopId, targetId);
    if (!deposit.ok) return c.json({ success: false, error: deposit.error }, deposit.status);
    // The shop can only cancel a booking that is still standing. One that is
    // already cancelled was cancelled by someone, for a reason on record; its
    // deposit goes back through an ordinary request.
    if (shopCancelled && deposit.bookingStatus === "cancelled") {
      return c.json(
        { success: false, error: "This booking is already cancelled. Ask for the refund with a reason instead." },
        400
      );
    }
    amountPence = deposit.pence;
  } else {
    targetId = typeof body.sale_id === "string" ? body.sale_id : "";
    if (!targetId) return c.json({ success: false, error: "sale_id is required" }, 400);
    const priced = await priceSaleRefund(db, shopId, targetId, Array.isArray(body.lines) ? body.lines : []);
    if (!priced.ok) return c.json({ success: false, error: priced.error }, priced.status);
    amountPence = priced.customerRefundPence;
    const lines: RefundLine[] = priced.priced.map((p) => ({
      sale_item_id: p.item.id,
      quantity: p.qty,
      ...(p.restock ? {} : { restock: false }),
    }));
    linesJson = JSON.stringify(lines);
  }

  const column = kind === "deposit" ? "booking_id" : "sale_id";
  const requestId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  try {
    return await auditFor(c).run(
      {
        action: "payment.refund.request",
        shopId,
        entityType: "refund_request",
        entityId: requestId,
        details: {
          kind,
          [column]: targetId,
          amount_pence: amountPence,
          evidence: evidenceKey !== null,
          ...(shopCancelled ? { shop_cancelled: true } : {}),
        },
      },
      async (): Promise<Response> => {
        // One open request per booking or sale. The insert is guarded in the
        // same statement, so two people filing at once leave one request.
        const inserted = await db
          .prepare(
            `INSERT INTO refund_requests
               (id, shop_id, kind, booking_id, sale_id, lines_json, amount_pence, reason,
                evidence_key, evidence_name, evidence_type, status, requested_by, requested_at, shop_cancelled)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13, ?15
             WHERE NOT EXISTS (
               SELECT 1 FROM refund_requests
               WHERE shop_id = ?2 AND kind = ?3 AND ${column} = ?14 AND status IN ('pending','approving')
             )`
          )
          .bind(
            requestId,
            shopId,
            kind,
            kind === "deposit" ? targetId : null,
            kind === "sale" ? targetId : null,
            linesJson,
            amountPence,
            reason,
            evidenceKey,
            evidenceName,
            evidenceType,
            user.sub,
            nowIso,
            targetId,
            shopCancelled ? 1 : 0
          )
          .run();
        if ((inserted.meta?.changes ?? 0) !== 1) {
          return c.json(
            { success: false, error: "A refund request for this is already waiting for a decision." },
            409
          );
        }
        return c.json(
          { success: true, data: { id: requestId, kind, status: "pending", amount_pence: amountPence } },
          201
        );
      },
      statusOutcome()
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

// ─── GET /:shopId/refund-requests — the review list ──────────────────────────

r.get("/:shopId/refund-requests", async (c) => {
  const shopId = c.req.param("shopId");
  const db = c.env.DB;
  if (!(await shopExists(c, shopId))) {
    return c.json({ success: false, error: "Shop not found" }, 404);
  }
  const filter = c.req.query("status");
  const where =
    filter === "pending"
      ? "AND rr.status IN ('pending','approving')"
      : filter === "decided"
        ? "AND rr.status IN ('approved','declined')"
        : "";
  const rows = await db
    .prepare(
      `SELECT rr.id, rr.kind, rr.booking_id, rr.sale_id, rr.lines_json, rr.amount_pence, rr.reason,
              rr.evidence_name, rr.evidence_type, rr.evidence_key IS NOT NULL AS has_evidence,
              rr.evidence_expired_at IS NOT NULL AS evidence_expired,
              rr.status, rr.requested_by, rr.requested_at, rr.reviewed_by, rr.reviewed_at,
              rr.review_note, rr.refunded_pence, rr.shop_cancelled,
              ru.name AS requested_by_name, rv.name AS reviewed_by_name,
              COALESCE(b.customer_name, s.customer_name) AS customer_name,
              b.booking_date, b.start_time, b.status AS booking_status,
              s.created_at AS sale_created_at, s.tender_type AS sale_tender_type
       FROM refund_requests rr
       LEFT JOIN platform_users ru ON ru.id = rr.requested_by
       LEFT JOIN platform_users rv ON rv.id = rr.reviewed_by
       LEFT JOIN bookings b ON b.id = rr.booking_id AND b.shop_id = rr.shop_id
       LEFT JOIN sales s ON s.id = rr.sale_id AND s.shop_id = rr.shop_id
       WHERE rr.shop_id = ? ${where}
       ORDER BY rr.requested_at DESC
       LIMIT 200`
    )
    .bind(shopId)
    .all<Record<string, unknown>>();
  const data = (rows.results ?? []).map((row) => ({
    ...row,
    has_evidence: Number(row.has_evidence) === 1,
    evidence_expired: Number(row.evidence_expired) === 1,
    shop_cancelled: Number(row.shop_cancelled) === 1,
    // A claim in flight reads as pending to the page.
    status: row.status === "approving" ? "pending" : row.status,
  }));
  return c.json({ success: true, data });
});

// ─── POST /:shopId/refund-requests/:requestId/evidence ───────────────────────
// Attach evidence to a request that was filed without any, while it still
// waits. Once only: a request's evidence is never replaced, so what an
// approver saw is what stays on record.

r.post("/:shopId/refund-requests/:requestId/evidence", async (c) => {
  const shopId = c.req.param("shopId");
  const requestId = c.req.param("requestId");
  const db = c.env.DB;
  const user = getUser(c);

  const body = await readJsonObject<{ evidence_key?: string; evidence_name?: string; evidence_type?: string }>(c.req);
  if (!body) return c.json({ success: false, error: "Invalid JSON" }, 400);
  const key = typeof body.evidence_key === "string" ? body.evidence_key : "";
  // Same rule as filing: under this shop's evidence folder, and really there.
  if (!key || !key.startsWith(evidencePrefix(shopId)) || key.includes("..") || !(await c.env.AUDIT_ARCHIVE.head(key))) {
    return c.json({ success: false, error: "Invalid evidence file" }, 400);
  }
  const name = typeof body.evidence_name === "string" ? body.evidence_name.slice(0, 200) : null;
  const type = typeof body.evidence_type === "string" ? body.evidence_type.slice(0, 100) : null;

  const existing = await db
    .prepare("SELECT requested_by FROM refund_requests WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(requestId, shopId)
    .first<{ requested_by: string }>();
  if (!existing) return c.json({ success: false, error: "Refund request not found" }, 404);
  // Whoever filed it, or someone who could decide it.
  if (existing.requested_by !== user.sub && user.role !== "admin" && user.role !== "developer") {
    return c.json({ success: false, error: "Only the person who filed this request can add its evidence" }, 403);
  }

  try {
    return await auditFor(c).run(
      { action: "payment.refund.evidence", shopId, entityType: "refund_request", entityId: requestId },
      async (): Promise<Response> => {
        const attached = await db
          .prepare(
            `UPDATE refund_requests SET evidence_key = ?, evidence_name = ?, evidence_type = ?
             WHERE id = ? AND shop_id = ? AND status = 'pending' AND evidence_key IS NULL`
          )
          .bind(key, name, type, requestId, shopId)
          .run();
        if ((attached.meta?.changes ?? 0) !== 1) {
          return c.json(
            {
              success: false,
              error: "Evidence can be added once, to a request that is still waiting. Reload to see where this one stands.",
            },
            409
          );
        }
        return c.json({ success: true, data: { id: requestId, has_evidence: true } });
      },
      statusOutcome()
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

// ─── POST /:shopId/refund-requests/:requestId/decline ────────────────────────

r.post("/:shopId/refund-requests/:requestId/decline", async (c) => {
  const shopId = c.req.param("shopId");
  const requestId = c.req.param("requestId");
  const db = c.env.DB;
  const user = getUser(c);
  if (user.role !== "admin" && user.role !== "developer") {
    return c.json({ success: false, error: "Admin role required" }, 403);
  }
  const body = (await readJsonObject<{ note?: string }>(c.req)) ?? {};
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, NOTE_MAX) : null;

  const existing = await db
    .prepare("SELECT id FROM refund_requests WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(requestId, shopId)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "Refund request not found" }, 404);

  try {
    return await auditFor(c).run(
      { action: "payment.refund.decline", shopId, entityType: "refund_request", entityId: requestId },
      async (): Promise<Response> => {
        const declined = await db
          .prepare(
            `UPDATE refund_requests SET status = 'declined', reviewed_by = ?, reviewed_at = ?, review_note = ?
             WHERE id = ? AND shop_id = ? AND status = 'pending'`
          )
          .bind(user.sub, new Date().toISOString(), note, requestId, shopId)
          .run();
        if ((declined.meta?.changes ?? 0) !== 1) {
          return c.json(
            { success: false, error: "This refund request has already been decided. Reload to see it." },
            409
          );
        }
        return c.json({ success: true, data: { id: requestId, status: "declined" } });
      },
      statusOutcome()
    );
  } catch (e) {
    if (e instanceof AuditWriteError) return auditRefused(c);
    throw e;
  }
});

export default r;
