import { describe, expect, it } from "vitest";
import { csvCell, penceToPounds, revenueCsv } from "./revenueCsv";

describe("penceToPounds", () => {
  it("writes integer pence as pounds with two decimals", () => {
    expect(penceToPounds(0)).toBe("0.00");
    expect(penceToPounds(5)).toBe("0.05");
    expect(penceToPounds(1234)).toBe("12.34");
    expect(penceToPounds(100000)).toBe("1000.00");
    expect(penceToPounds(-250)).toBe("-2.50");
    // 1.15 * 100 is 114.99999999999999 in floating point; pence never go through it.
    expect(penceToPounds(115)).toBe("1.15");
  });
});

describe("csvCell", () => {
  it("quotes a leading =, +, - or @ so a spreadsheet does not run it", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+44 7700 900000")).toBe("'+44 7700 900000");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("@handle")).toBe("'@handle");
  });

  it("leaves plain numbers alone, negative ones included", () => {
    expect(csvCell(12)).toBe("12");
    expect(csvCell("-2.50")).toBe("-2.50");
  });

  it("escapes commas, quotes and line breaks", () => {
    expect(csvCell('Cut, "wash" and dry')).toBe('"Cut, ""wash"" and dry"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });
});

describe("revenueCsv", () => {
  it("lists the month total, then staff, services and days", () => {
    const csv = revenueCsv({
      year: 2026,
      month: 3,
      summary: { booking_count: 3, gross_pence: 7550, commission_pence: 755 },
      by_staff: [{ display_name: "=Sam", booking_count: 3, gross_pence: 7550, commission_pence: 755 }],
      by_service: [{ service_name: "Cut, beard", booking_count: 3, gross_pence: 7550 }],
      daily: [{ booking_date: "2026-03-02", booking_count: 3, gross_pence: 7550, commission_pence: 755 }],
    });
    expect(csv).toBe(
      [
        "Section,Name,Bookings,Gross (GBP),Commission (GBP),Net (GBP)",
        "Month total,2026-03,3,75.50,7.55,67.95",
        "Staff,'=Sam,3,75.50,7.55,67.95",
        'Service,"Cut, beard",3,75.50,,',
        "Day,2026-03-02,3,75.50,7.55,67.95",
        "",
      ].join("\r\n"),
    );
  });
});
