import { Hono } from "hono";
import type { Context } from "hono";
import { readJsonObject } from "@repo/utils";
import type { Bindings } from "../bindings.js";
import { authMiddleware, extractSessionJwt } from "../middleware/auth.js";
import { requireShopRole } from "../middleware/rbac.js";
import { getRefundRequestEvidence } from "../db/queries.js";

// ─── /api/shops/:shopId/refund-requests ──────────────────────────────────────
// Refund review. No refund is issued on one tap: someone at the shop files a
// request with a written reason and, optionally, an evidence file; the owner
// or a developer approves or declines it.
//
// The booking worker owns the requests (it owns the money paths and records
// each change in the audit trail itself). This router adds the one thing that
// worker cannot do: it has no file storage, so an evidence file is stored
// here, in the private audit bucket, and its key is handed on with the
// request. Approval has no route of its own: it is the refund route
// (sales/:saleId/refund, or a booking cancel with refund_deposit), called
// with the request's id.

type Ctx = Context<{ Bindings: Bindings }>;

const refundRequests = new Hono<{ Bindings: Bindings }>();

refundRequests.use("*", authMiddleware);

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
/** What may be attached, by the type the browser reports. Nothing that a
 *  browser would run when the file is opened. */
const EVIDENCE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

function bookingHeaders(c: Ctx): Headers {
  // The booking worker's auth is Bearer-only; a cookie session carries the
  // same JWT, so mint the header from whichever transport arrived.
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = extractSessionJwt(c.req.raw.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function bookingUrl(c: Ctx, suffix = ""): string {
  const shopId = c.req.param("shopId")!;
  return `https://booking/booking/shops/${shopId}/refund-requests${suffix}${new URL(c.req.url).search}`;
}

refundRequests.get("/", requireShopRole("admin", "staff"), (c) =>
  c.env.BOOKING.fetch(new Request(bookingUrl(c), { headers: bookingHeaders(c) }))
);

refundRequests.post("/", requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  let fields: Record<string, unknown>;
  let file: File | null = null;

  if ((c.req.header("Content-Type") ?? "").includes("multipart/form-data")) {
    let form: Record<string, string | File>;
    try {
      form = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      return c.json({ success: false, error: "Invalid multipart body" }, 400);
    }
    let lines: unknown;
    if (typeof form.lines === "string" && form.lines.length > 0) {
      try {
        lines = JSON.parse(form.lines);
      } catch {
        return c.json({ success: false, error: "lines must be JSON" }, 400);
      }
    }
    fields = {
      kind: form.kind,
      booking_id: form.booking_id,
      sale_id: form.sale_id,
      reason: form.reason,
      ...(form.shop_cancelled === "1" ? { shop_cancelled: true } : {}),
      ...(lines !== undefined ? { lines } : {}),
    };
    if (form.evidence instanceof File && form.evidence.size > 0) file = form.evidence;
  } else {
    const body = await readJsonObject<Record<string, unknown>>(c.req);
    if (!body) return c.json({ success: false, error: "Invalid JSON" }, 400);
    // A key sent by the caller is never trusted: only a file stored below
    // can be attached.
    fields = { ...body };
    for (const key of ["evidence_key", "evidence_name", "evidence_type"]) delete fields[key];
  }

  let evidenceKey: string | null = null;
  if (file) {
    const ext = EVIDENCE_TYPES[file.type];
    if (!ext) {
      return c.json({ success: false, error: "Evidence must be a PNG, JPEG or WebP image, or a PDF." }, 400);
    }
    if (file.size > MAX_EVIDENCE_BYTES) {
      return c.json({ success: false, error: "Evidence file too large (max 5MB)" }, 400);
    }
    evidenceKey = `refund-evidence/${shopId}/${crypto.randomUUID()}.${ext}`;
    await c.env.AUDIT_ARCHIVE.put(evidenceKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
    });
    fields = {
      ...fields,
      evidence_key: evidenceKey,
      evidence_name: file.name.slice(0, 200),
      evidence_type: file.type,
    };
  }

  let res: Response;
  try {
    res = await c.env.BOOKING.fetch(
      new Request(bookingUrl(c), { method: "POST", headers: bookingHeaders(c), body: JSON.stringify(fields) })
    );
  } catch (e) {
    if (evidenceKey) await c.env.AUDIT_ARCHIVE.delete(evidenceKey).catch(() => {});
    throw e;
  }
  // No request was filed: the file belongs to nothing, so it does not stay.
  if (!res.ok && evidenceKey) await c.env.AUDIT_ARCHIVE.delete(evidenceKey).catch(() => {});
  return res;
});

refundRequests.post("/:requestId/decline", requireShopRole("admin"), (c) =>
  c.env.BOOKING.fetch(
    new Request(bookingUrl(c, `/${encodeURIComponent(c.req.param("requestId")!)}/decline`), {
      method: "POST",
      headers: bookingHeaders(c),
      body: c.req.raw.body,
    })
  )
);

refundRequests.get("/:requestId/evidence", requireShopRole("admin", "staff"), async (c) => {
  const shopId = c.req.param("shopId")!;
  const evidence = await getRefundRequestEvidence(c.env.DB, shopId, c.req.param("requestId")!);
  if (!evidence?.evidence_key) return c.json({ success: false, error: "Not found" }, 404);
  const object = await c.env.AUDIT_ARCHIVE.get(evidence.evidence_key);
  if (!object) return c.json({ success: false, error: "Not found" }, 404);
  const type = evidence.evidence_type && EVIDENCE_TYPES[evidence.evidence_type] ? evidence.evidence_type : "application/octet-stream";
  const name = (evidence.evidence_name ?? "evidence").replace(/[^\w.\- ]+/g, "_");
  return new Response(object.body, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export default refundRequests;
