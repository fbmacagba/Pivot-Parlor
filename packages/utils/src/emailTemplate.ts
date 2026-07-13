// Shared transactional-email template helpers, used by both the main worker
// (reminder, EOD, verification, review emails) and the booking worker
// (confirmation email). Email HTML has hard client constraints that normal
// web markup does not:
//   - Gmail strips display:flex, so all layout is <table> based.
//   - <style> blocks are unreliable (stripped on forward, ignored by Outlook),
//     so every style that matters is inlined on the element.
//   - Workers run in UTC, so wall-clock times must be rendered in the shop's
//     IANA timezone, never via Date#getHours().
// Colors keep the brand (gold on near-black) but every text tone meets WCAG
// AA 4.5:1 against its background.

const COLORS = {
  page: "#0d0d0d",
  card: "#1a1a1a",
  header: "#111111",
  border: "#3a3a3a",
  text: "#ffffff",
  muted: "#b3bac4", // labels, subtitles, notes (~8:1 on card)
  footer: "#9ca3af", // (~6.5:1 on card)
  gold: "#c9a84c",
  goldBright: "#e3c26d", // highlight text (~11:1 on highlight bg)
  highlightBg: "#241d07",
  highlightBorder: "#a16207",
} as const;

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif";

/** "2026-07-14" -> "Tuesday, 14 July 2026". booking_date is shop-local. */
export function formatEmailDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * ISO instant -> "12:00pm" in the shop's IANA timezone. Workers run in UTC,
 * so formatting without an explicit zone shows UTC wall-clock (a 12:00 BST
 * booking rendered as 11:00am). Falls back to Europe/London (the shops.timezone
 * column default) if the stored zone name is invalid.
 */
export function formatEmailTime(iso: string, timezone: string): string {
  const d = new Date(iso);
  const opts = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  } as const;
  let formatted: string;
  try {
    formatted = d.toLocaleTimeString("en-GB", { ...opts, timeZone: timezone });
  } catch {
    formatted = d.toLocaleTimeString("en-GB", {
      ...opts,
      timeZone: "Europe/London",
    });
  }
  return formatted.replace(/\s+/g, "").toLowerCase();
}

/** Card header block (title + subtitle). Returns a <tr> for emailBaseLayout. */
export function emailHeader(title: string, subtitle: string): string {
  return `<tr><td style="background:${COLORS.header};padding:28px 32px;border-bottom:1px solid ${COLORS.border};border-radius:16px 16px 0 0;">
  <h1 style="margin:0;font-size:20px;font-weight:700;color:${COLORS.text};font-family:${FONT_STACK};">${title}</h1>
  <p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:${COLORS.muted};font-family:${FONT_STACK};">${subtitle}</p>
</td></tr>`;
}

/** Card body block wrapping arbitrary inner HTML. Returns a <tr>. */
export function emailBodySection(inner: string): string {
  return `<tr><td style="padding:28px 32px;font-family:${FONT_STACK};">${inner}</td></tr>`;
}

/** Gold highlight panel (appointment date + time). */
export function emailHighlight(line1: string, line2: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
  <tr><td style="background:${COLORS.highlightBg};border:1px solid ${COLORS.highlightBorder};border-radius:10px;padding:16px 20px;">
    <div style="font-size:22px;font-weight:700;color:${COLORS.goldBright};font-family:${FONT_STACK};">${line1}</div>
    <div style="font-size:15px;color:${COLORS.goldBright};margin-top:4px;font-family:${FONT_STACK};">${line2}</div>
  </td></tr>
</table>`;
}

export interface EmailDetailRow {
  label: string;
  value: string;
  /** Render the value in large gold (money totals). */
  accent?: boolean;
  /** Render the value as a link (e.g. an address opening Google Maps). */
  href?: string;
}

/**
 * Label/value rows as a table (Gmail strips display:flex — the old flex rows
 * collapsed into "ServiceHaircut 1"). Labels are muted-but-readable, values
 * white and right-aligned; rows after the first carry a top hairline.
 */
export function emailDetailRows(rows: EmailDetailRow[]): string {
  const trs = rows
    .map((row, i) => {
      const borderTop = i === 0 ? "" : `border-top:1px solid ${COLORS.border};`;
      const valueStyle = row.accent
        ? `font-size:17px;font-weight:700;color:${COLORS.goldBright};`
        : `font-size:15px;font-weight:600;color:${COLORS.text};`;
      const value = row.href
        ? `<a href="${row.href}" style="color:${COLORS.goldBright};text-decoration:underline;">${row.value}</a>`
        : row.value;
      return `<tr>
    <td style="padding:12px 16px 12px 0;font-size:13px;color:${COLORS.muted};white-space:nowrap;${borderTop}font-family:${FONT_STACK};vertical-align:top;">${row.label}</td>
    <td align="right" style="padding:12px 0;${valueStyle}${borderTop}font-family:${FONT_STACK};">${value}</td>
  </tr>`;
    })
    .join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${trs}
</table>`;
}

/**
 * Google Maps link for a free-form address. The `query` form opens the live
 * map (the Maps app on mobile) pinned to the best match; including the shop
 * name improves place matching.
 */
export function googleMapsUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Muted note paragraph (cancellation policy, expiry notes, etc.). */
export function emailNote(text: string): string {
  return `<p style="font-size:13px;line-height:1.6;color:${COLORS.muted};margin:20px 0 0;font-family:${FONT_STACK};">${text}</p>`;
}

/** Brand CTA button (gold on dark). */
export function emailButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${COLORS.gold};color:${COLORS.page};font-weight:700;font-size:14px;padding:13px 28px;border-radius:8px;text-decoration:none;margin-top:20px;font-family:${FONT_STACK};">${label}</a>`;
}

/**
 * Full document shell. `content` is a sequence of <tr> blocks (emailHeader /
 * emailBodySection); the footer row is appended here.
 */
export function emailBaseLayout(
  content: string,
  shopName: string,
  footerNote = "You received this because you made a booking.",
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:40px 20px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
    <tr><td align="center" style="padding-bottom:24px;">
      <span style="font-size:13px;font-weight:700;color:${COLORS.gold};letter-spacing:0.1em;text-transform:uppercase;font-family:${FONT_STACK};">Pivot Parlor</span>
    </td></tr>
    <tr><td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${content}
        <tr><td style="padding:20px 32px;text-align:center;font-size:12px;line-height:1.6;color:${COLORS.footer};border-top:1px solid ${COLORS.border};font-family:${FONT_STACK};">
          ${shopName} · Powered by Pivot Parlor<br/>
          ${footerNote}
        </td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}
