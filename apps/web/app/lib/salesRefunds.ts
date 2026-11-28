/**
 * Shared loader/action logic for asking for a refund on a till sale, used by
 * the owner's Sales page (/admin/sales) and the staff Refunds page
 * (/staff/refunds). Both file a request; neither moves money. The refund
 * runs only when the owner approves the request (admin.refunds.tsx).
 */
import { data as json, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { formatPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";
import { ukToday } from "~/lib/dateFormat";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { DEVELOPER_STAFF_READ_ONLY, pageShopId, withShopId } from "~/lib/pageShop";
import {
  addEvidenceFromForm,
  evidenceFrom,
  fileRefundRequest,
  refundEvidenceProblem,
  refundReasonProblem,
  type RefundRequest,
} from "~/lib/refundRequests";

/** The sales list answers with at most this many rows for a day. */
export const SALES_LIST_LIMIT = 100;

export interface SaleRow {
  id: string;
  booking_id: string | null;
  customer_name: string | null;
  subtotal_pence: number;
  discount_pence: number;
  tip_pence: number;
  total_pence: number;
  tender_type: string;
  status: string;
  created_at: string;
  /** Sent on every row now; optional so a list from an older API still reads. */
  refunded_pence?: number | null;
}

export interface SaleItem {
  id: string;
  item_type: string;
  name: string;
  quantity: number;
  returned_quantity: number;
  unit_price_pence: number;
  line_total_pence: number;
}

export interface SaleReturn {
  id: string;
  refund_pence: number;
  status: string;
  reason: string | null;
  created_at: string;
}

export interface SaleDetail extends SaleRow {
  refunded_pence: number;
  items: SaleItem[];
  returns: SaleReturn[];
}

export type SalesRefundActionData = { ok: true; message: string } | { error: string };

export async function salesRefundLoader({ request, context }: LoaderFunctionArgs, role: "admin" | "staff") {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, role, env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);
  // Staff View is read-only for a developer (staff.tsx): they ask for a
  // refund from Admin view, where they already manage the shop.
  if (role === "staff" && user.role === "developer") throw redirect(withShopId("/admin/sales", shopId));

  const url = new URL(request.url);
  // The shop's day, as the booking worker's sales list reads it.
  const today = ukToday();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "") ? url.searchParams.get("date")! : today;
  const saleId = url.searchParams.get("sale");

  let sales: SaleRow[] = [];
  let detail: SaleDetail | null = null;
  let loadError = false;
  let detailError = false;
  // Sales that already have a refund request waiting: no second one is filed.
  let pendingRefundSaleIds: string[] = [];
  // Staff page only: what the signed-in person has asked for, newest first.
  let myRequests: RefundRequest[] = [];
  let myRequestsError = false;
  if (shopId) {
    const wantsDetail = Boolean(saleId && /^[A-Za-z0-9_-]{1,100}$/.test(saleId));
    const wantsRequests = wantsDetail || role === "staff";
    const [salesRes, detailRes, requestsRes] = await Promise.allSettled([
      api.get<SaleRow[]>(`/api/shops/${shopId}/sales?date=${date}`),
      wantsDetail ? api.get<SaleDetail>(`/api/shops/${shopId}/sales/${saleId}`) : Promise.resolve(null),
      wantsRequests
        ? api.get<RefundRequest[]>(`/api/shops/${shopId}/refund-requests${role === "staff" ? "" : "?status=pending"}`)
        : Promise.resolve([]),
    ]);
    if (requestsRes.status === "fulfilled") {
      const requests = requestsRes.value ?? [];
      pendingRefundSaleIds = requests.flatMap((r) => (r.status === "pending" && r.sale_id ? [r.sale_id] : []));
      if (role === "staff") myRequests = requests.filter((r) => r.requested_by === user.sub);
    } else if (role === "staff") {
      myRequestsError = true;
    }
    if (salesRes.status === "fulfilled") sales = salesRes.value ?? [];
    else loadError = true;
    if (detailRes.status === "fulfilled") detail = detailRes.value;
    else detailError = true;
  }

  return json({
    shopId,
    developerNeedsShop: user.role === "developer" && !shopId,
    date,
    sales,
    detail,
    loadError,
    detailError,
    pendingRefundSaleIds,
    myRequests,
    myRequestsError,
  });
}

export async function salesRefundAction({ request, context }: ActionFunctionArgs, role: "admin" | "staff") {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, role, env.API_URL);
  if (role === "staff" && user.role === "developer") {
    return json<SalesRefundActionData>({ error: DEVELOPER_STAFF_READ_ONLY }, { status: 403 });
  }
  const token = getSessionToken(request);
  if (!token) return json<SalesRefundActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await readFormData(request);
  if (!form) return json<SalesRefundActionData>({ error: UNREADABLE_FORM }, { status: 400 });
  const shopId = pageShopId(request, user, String(form.get("shopId") ?? "").trim() || null);
  if (shopId && form.get("intent") === "add_evidence") {
    const added = await addEvidenceFromForm(env.API_URL, token, shopId, form);
    return json<SalesRefundActionData>(added.body, { status: added.status });
  }
  const saleId = String(form.get("saleId") ?? "").trim();
  if (!shopId || !saleId) return json<SalesRefundActionData>({ error: "Missing shop or sale." }, { status: 400 });

  let lines: Array<{ sale_item_id: string; quantity: number; restock: boolean }>;
  try {
    lines = JSON.parse(String(form.get("lines") ?? "[]"));
  } catch {
    return json<SalesRefundActionData>({ error: "Invalid refund payload." }, { status: 400 });
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return json<SalesRefundActionData>({ error: "Select at least one item to refund." }, { status: 400 });
  }

  const reason = String(form.get("reason") ?? "").trim();
  const reasonProblem = refundReasonProblem(reason);
  if (reasonProblem) return json<SalesRefundActionData>({ error: reasonProblem }, { status: 400 });
  const evidence = evidenceFrom(form);
  const evidenceProblem = refundEvidenceProblem(evidence);
  if (evidenceProblem) return json<SalesRefundActionData>({ error: evidenceProblem }, { status: 400 });

  // This files a request. The refund itself runs only when the owner
  // approves it on the Refunds page.
  try {
    const filed = await fileRefundRequest(
      env.API_URL,
      token,
      shopId,
      { kind: "sale", sale_id: saleId, lines, reason },
      evidence
    );
    return json<SalesRefundActionData>({
      ok: true,
      message: `Refund request for ${formatPence(filed.amount_pence)} filed. No money has moved: it waits for approval.`,
    });
  } catch (e) {
    return json<SalesRefundActionData>(
      { error: e instanceof Error ? e.message : "The request could not be filed" },
      { status: 400 }
    );
  }
}
