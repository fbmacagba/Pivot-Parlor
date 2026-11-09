// Resend email service — booking confirmation.
// Moved from apps/worker/src/services/email.ts in WS-1: the booking worker
// owns the booking lifecycle, so it sends the confirmation. Reminder, review
// and EOD emails stay with the main worker (its queue consumer and crons).
// Template building blocks live in @repo/utils (emailTemplate.ts) so both
// workers render identically.

import {
  formatPence,
  formatEmailDate,
  formatEmailTime,
  emailBaseLayout,
  emailHeader,
  emailBodySection,
  emailHighlight,
  emailDetailRows,
  emailNote,
  googleMapsUrl,
} from "@repo/utils";

const RESEND_API = "https://api.resend.com/emails";
const FROM = "Pivot Parlor <bookings@pivotparlor.com>";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BookingEmailData {
  customer_name: string;
  customer_email: string;
  service_name: string;
  staff_name: string;
  shop_name: string;
  shop_slug: string;
  booking_date: string; // "YYYY-MM-DD" (shop-local)
  start_time: string; // ISO string (UTC instant)
  timezone: string; // shop IANA timezone (shops.timezone)
  duration_min: number;
  amount_pence: number; // integer pence (WS-4)
  booking_id: string;
  /** Physical address (shop_settings.address); links to Google Maps when set. */
  shop_address?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "HTTP <status>", plus Resend's error code (e.g. invalid_api_key) when the
 *  body names one. Resend's message can echo the recipient, so only a plain
 *  identifier code is kept. */
function resendFailure(status: number, body: string): string {
  let code: unknown;
  try {
    code = (JSON.parse(body) as { name?: unknown }).name;
  } catch {
    code = undefined;
  }
  return typeof code === "string" && /^[a-z_]{1,64}$/i.test(code) ? `HTTP ${status} (${code})` : `HTTP ${status}`;
}

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    console.error(`[email] Resend refused the send: ${resendFailure(res.status, err)}`);
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}

// ─── Email templates ──────────────────────────────────────────────────────────

function confirmationHtml(d: BookingEmailData): string {
  const address = d.shop_address?.trim();
  return emailBaseLayout(
    emailHeader(
      "✅ Booking confirmed",
      `Hi ${d.customer_name}, your appointment is booked.`,
    ) +
      emailBodySection(
        emailHighlight(
          formatEmailDate(d.booking_date),
          `${formatEmailTime(d.start_time, d.timezone)} · ${d.duration_min} min`,
        ) +
          emailDetailRows([
            { label: "Service", value: d.service_name },
            { label: "With", value: d.staff_name },
            { label: "Location", value: d.shop_name },
            // Clickable address: opens the live map (the Maps app on phones)
            // pinned to the shop.
            ...(address
              ? [
                  {
                    label: "Address",
                    value: address,
                    // Address only: prefixing the shop name pins ONLY when
                    // Google knows the business; a bare address always
                    // geocodes to a marker.
                    href: googleMapsUrl(address),
                  },
                ]
              : []),
            {
              label: "Total",
              value: formatPence(d.amount_pence),
              accent: true,
            },
          ]) +
          emailNote(
            "Need to cancel or reschedule? Reply to this email or contact the shop directly.",
          ),
      ),
    d.shop_name,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendBookingConfirmation(
  apiKey: string,
  data: BookingEmailData,
): Promise<void> {
  await sendEmail(
    apiKey,
    data.customer_email,
    `Booking confirmed: ${data.service_name} at ${data.shop_name}`,
    confirmationHtml(data),
  );
}
