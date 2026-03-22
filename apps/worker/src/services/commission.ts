import type { D1Database } from "@cloudflare/workers-types";

export interface CommissionBreakdown {
  amount: number;
  commission: number;
  shop_revenue: number;
  commission_rate: number;
}

/**
 * Calculates platform commission for a booking.
 * commissionRate is a decimal (e.g. 0.10 = 10%).
 */
export function calculateCommission(amount: number, commissionRate: number): CommissionBreakdown {
  const commission = Math.round(amount * commissionRate * 100) / 100;
  return {
    amount,
    commission,
    shop_revenue: Math.round((amount - commission) * 100) / 100,
    commission_rate: commissionRate,
  };
}

export async function getPlatformRevenueSummary(
  db: D1Database,
  year: number,
  month: number
) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-31`;

  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS booking_count,
         COALESCE(SUM(amount), 0) AS total_gross,
         COALESCE(SUM(commission), 0) AS total_commission
       FROM bookings
       WHERE booking_date >= ? AND booking_date <= ?
         AND status = 'completed'`
    )
    .bind(from, to)
    .first<{
      booking_count: number;
      total_gross: number;
      total_commission: number;
    }>();

  return {
    booking_count: row?.booking_count ?? 0,
    total_gross: row?.total_gross ?? 0,
    total_commission: row?.total_commission ?? 0,
    shop_revenue: (row?.total_gross ?? 0) - (row?.total_commission ?? 0),
  };
}

export async function getShopRevenueSummary(
  db: D1Database,
  shopId: string,
  year: number,
  month: number
) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const to = `${year}-${String(month).padStart(2, "0")}-31`;

  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS booking_count,
         COALESCE(SUM(amount), 0) AS gross,
         COALESCE(SUM(commission), 0) AS commission
       FROM bookings
       WHERE shop_id = ?
         AND booking_date >= ? AND booking_date <= ?
         AND status = 'completed'`
    )
    .bind(shopId, from, to)
    .first<{
      booking_count: number;
      gross: number;
      commission: number;
    }>();

  const gross = row?.gross ?? 0;
  const commission = row?.commission ?? 0;

  return {
    booking_count: row?.booking_count ?? 0,
    gross,
    commission,
    shop_revenue: gross - commission,
  };
}
