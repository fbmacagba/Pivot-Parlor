/**
 * Shared loader/action logic for the POS screen (WS-3 Phase 1), used by both
 * /admin/pos and /staff/pos. All worker calls run server-side with the
 * session token; the sale itself is created by the booking worker via the
 * main worker's /api/shops/:shopId/sales proxy.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { DEVELOPER_STAFF_READ_ONLY, pageShopId, withShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { parsePoundsToPence } from "@repo/utils";
import { readFormData, UNREADABLE_FORM } from "./formBody";

export interface PosService {
  id: string;
  name: string;
  price_pence: number;
  category: string;
}

export interface PosProduct {
  id: string;
  name: string;
  brand: string | null;
  sku: string | null;
  retail_price_pence: number;
  track_stock: number;
  is_professional: number;
  is_active: number;
  total_quantity: number;
}

export interface PosStaff {
  id: string;
  display_name: string;
}

export interface PosSaleResult {
  id: string;
  status: string;
  subtotal_pence: number;
  discount_pence: number;
  tip_pence: number;
  commission_pence: number;
  total_pence: number;
  tender_type: string;
  payment_url: string | null;
}

export type PosActionData =
  | { ok: true; sale: PosSaleResult }
  | { ok: true; voided: true }
  | { error: string };

export async function posLoader({ request, context }: LoaderFunctionArgs, role: "admin" | "staff") {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, role, env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);
  // Staff View is read-only for a developer (staff.tsx): the shop's till for
  // them is Admin view's, where they already manage the shop.
  if (role === "staff" && user.role === "developer") throw redirect(withShopId("/admin/pos", shopId));

  let services: PosService[] = [];
  let products: PosProduct[] = [];
  let staff: PosStaff[] = [];
  if (shopId) {
    // Each list degrades to empty rather than failing the page.
    [services, products, staff] = await Promise.all([
      api.get<PosService[]>(`/api/shops/${shopId}/services`).catch(() => []),
      api.get<PosProduct[]>(`/api/shops/${shopId}/products`).catch(() => []),
      api.get<PosStaff[]>(`/api/shops/${shopId}/staff`).catch(() => []),
    ]);
  }

  return json({
    shopId,
    services,
    // Back-bar (professional-use) products are not retail lines.
    products: products.filter((p) => p.is_professional !== 1),
    staff,
    canVoid: user.role !== "staff",
    developerNeedsShop: user.role === "developer" && !shopId,
  });
}

export async function posAction({ request, context }: ActionFunctionArgs, role: "admin" | "staff") {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, role, env.API_URL);
  if (role === "staff" && user.role === "developer") {
    return json<PosActionData>({ error: DEVELOPER_STAFF_READ_ONLY }, { status: 403 });
  }
  const token = getSessionToken(request);
  if (!token) return json<PosActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await readFormData(request);
  if (!form) return json<PosActionData>({ error: UNREADABLE_FORM }, { status: 400 });
  const intent = String(form.get("intent") ?? "").trim();
  const shopId = pageShopId(request, user, String(form.get("shopId") ?? "").trim() || null);
  if (!shopId) {
    return json<PosActionData>(
      { error: "Missing shop. Developers open this page with ?shopId=…" },
      { status: 400 }
    );
  }
  const api = createApiClient(env.API_URL, token);

  if (intent === "void") {
    const saleId = String(form.get("saleId") ?? "").trim();
    if (!saleId) return json<PosActionData>({ error: "Missing sale ID." }, { status: 400 });
    try {
      await api.post(`/api/shops/${shopId}/sales/${saleId}/void`, {});
      return json<PosActionData>({ ok: true, voided: true });
    } catch (e) {
      return json<PosActionData>({ error: e instanceof Error ? e.message : "Void failed" }, { status: 400 });
    }
  }

  if (intent !== "sale") {
    return json<PosActionData>({ error: "Unknown action." }, { status: 400 });
  }

  let items: unknown;
  try {
    items = JSON.parse(String(form.get("cart") ?? "[]"));
  } catch {
    return json<PosActionData>({ error: "Invalid cart." }, { status: 400 });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return json<PosActionData>({ error: "The cart is empty." }, { status: 400 });
  }

  const tender = String(form.get("tender") ?? "");
  const discountStr = String(form.get("discount") ?? "").trim();
  const tipStr = String(form.get("tip") ?? "").trim();
  const discountPence = discountStr ? parsePoundsToPence(discountStr) : 0;
  const tipPence = tipStr ? parsePoundsToPence(tipStr) : 0;
  if (discountPence === null || tipPence === null) {
    return json<PosActionData>({ error: "Discount and tip must be valid amounts (e.g. 2.50)." }, { status: 400 });
  }

  const origin = new URL(request.url).origin;
  const body: Record<string, unknown> = {
    items,
    tender,
    discount_pence: discountPence,
    tip_pence: tipPence,
    staff_id: String(form.get("staff_id") ?? "").trim() || null,
    customer_email: String(form.get("customer_email") ?? "").trim() || null,
    note: String(form.get("note") ?? "").trim() || null,
  };
  if (tender === "stripe") {
    body.success_url = `${origin}/pay/done`;
    body.cancel_url = `${origin}/pay/cancelled`;
  }

  try {
    const result = await api.post<never>(`/api/shops/${shopId}/sales`, body);
    // The booking worker returns { success, sale } — the client unwraps
    // `data` envelopes only, so `sale` survives on the raw object.
    const sale = (result as { sale?: PosSaleResult }).sale;
    if (!sale) return json<PosActionData>({ error: "Malformed response from sales API." }, { status: 502 });
    return json<PosActionData>({ ok: true, sale });
  } catch (e) {
    return json<PosActionData>({ error: e instanceof Error ? e.message : "Sale failed" }, { status: 400 });
  }
}
