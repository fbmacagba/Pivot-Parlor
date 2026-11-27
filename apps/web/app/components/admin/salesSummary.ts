/**
 * Sums for the Sales page, all in integer pence: the day's cashing-up summary
 * and the amount a refund will come to before it is sent.
 */

export interface SummarySale {
  total_pence: number;
  tender_type: string;
  status: string;
  /** Present only when the sales list sends it; the summary says when it does not. */
  refunded_pence?: number | null;
}

export interface TenderTotal {
  tender: string;
  count: number;
  gross_pence: number;
}

export interface DaySummary {
  /** Sales where money was taken: completed, refunded or disputed. */
  count: number;
  gross_pence: number;
  /** Null when any counted sale came without its refunded amount. */
  refunds_pence: number | null;
  net_pence: number | null;
  by_tender: TenderTotal[];
}

/** Money changed hands on these; pending and voided sales took none. */
const TAKEN = new Set(["completed", "refunded", "disputed"]);

export function summariseSales(sales: SummarySale[]): DaySummary {
  const tenders = new Map<string, TenderTotal>();
  let count = 0;
  let gross = 0;
  let refunds: number | null = 0;
  for (const sale of sales) {
    if (!TAKEN.has(sale.status)) continue;
    count += 1;
    gross += sale.total_pence;
    const row = tenders.get(sale.tender_type) ?? { tender: sale.tender_type, count: 0, gross_pence: 0 };
    row.count += 1;
    row.gross_pence += sale.total_pence;
    tenders.set(sale.tender_type, row);
    if (refunds !== null) {
      refunds = typeof sale.refunded_pence === "number" ? refunds + sale.refunded_pence : null;
    }
  }
  return {
    count,
    gross_pence: gross,
    refunds_pence: refunds,
    net_pence: refunds === null ? null : gross - refunds,
    by_tender: [...tenders.values()].sort((a, b) => b.gross_pence - a.gross_pence || a.tender.localeCompare(b.tender)),
  };
}

/** "card_external" reads "Card machine"; an unknown tender is shown as written. */
export function tenderLabel(tender: string): string {
  if (tender === "cash") return "Cash";
  if (tender === "stripe") return "Card (online)";
  if (tender === "card_external") return "Card machine";
  const words = tender.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Other";
}

export interface RefundSale {
  subtotal_pence: number;
  discount_pence: number;
  refunded_pence: number;
  items: Array<{ id: string; quantity: number; line_total_pence: number }>;
}

/**
 * What the chosen lines come to, worked out the way the refund API does it
 * (each line's share of the discount comes off first; the total is capped at
 * what is left to refund). A service fee the customer paid on top is returned
 * by the API as well and is not part of this figure.
 */
export function refundAmountPence(sale: RefundSale, lines: Array<{ sale_item_id: string; quantity: number }>): number {
  let total = 0;
  for (const line of lines) {
    const item = sale.items.find((i) => i.id === line.sale_item_id);
    if (!item || item.quantity <= 0 || line.quantity <= 0) continue;
    const discountShare =
      sale.subtotal_pence > 0 ? Math.round((sale.discount_pence * item.line_total_pence) / sale.subtotal_pence) : 0;
    total += Math.round(((item.line_total_pence - discountShare) * line.quantity) / item.quantity);
  }
  const refundable = sale.subtotal_pence - sale.discount_pence - sale.refunded_pence;
  return Math.max(0, Math.min(total, refundable));
}
