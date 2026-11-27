/** The Revenue page's month as a CSV an accountant can open in a spreadsheet. */

export interface RevenueCsvInput {
  year: number;
  month: number;
  summary: { booking_count: number; gross_pence: number; commission_pence: number };
  by_staff: Array<{ display_name: string; booking_count: number; gross_pence: number; commission_pence: number }>;
  by_service: Array<{ service_name: string; booking_count: number; gross_pence: number }>;
  daily: Array<{ booking_date: string; booking_count: number; gross_pence: number; commission_pence: number }>;
}

/** Integer pence as pounds with two decimals ("1234" pence is "12.34"), with no float arithmetic. */
export function penceToPounds(pence: number): string {
  const whole = Math.trunc(pence);
  const abs = Math.abs(whole);
  return `${whole < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (it starts
 * with =, +, - or @) gets a leading single quote, so a staff member named
 * "=HYPERLINK(...)" stays text. A plain number, negative ones included, is
 * left as a number. Quotes, commas and line breaks are escaped the CSV way.
 */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@]/.test(text) && !PLAIN_NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function revenueCsv(data: RevenueCsvInput): string {
  const rows: Array<Array<string | number>> = [
    ["Section", "Name", "Bookings", "Gross (GBP)", "Commission (GBP)", "Net (GBP)"],
    [
      "Month total",
      `${data.year}-${String(data.month).padStart(2, "0")}`,
      data.summary.booking_count,
      penceToPounds(data.summary.gross_pence),
      penceToPounds(data.summary.commission_pence),
      penceToPounds(data.summary.gross_pence - data.summary.commission_pence),
    ],
  ];
  for (const r of data.by_staff) {
    rows.push([
      "Staff",
      r.display_name,
      r.booking_count,
      penceToPounds(r.gross_pence),
      penceToPounds(r.commission_pence),
      penceToPounds(r.gross_pence - r.commission_pence),
    ]);
  }
  for (const r of data.by_service) {
    rows.push(["Service", r.service_name, r.booking_count, penceToPounds(r.gross_pence), "", ""]);
  }
  for (const r of data.daily) {
    rows.push([
      "Day",
      r.booking_date,
      r.booking_count,
      penceToPounds(r.gross_pence),
      penceToPounds(r.commission_pence),
      penceToPounds(r.gross_pence - r.commission_pence),
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
