// apps/worker/src/services/email.ts
// Resend email service — 24h reminder, EOD developer alert, email
// verification and review requests. Template building blocks live in
// @repo/utils (emailTemplate.ts) so this worker and the booking worker
// (confirmation email) render identically.

import {
  formatEmailDate,
  formatEmailTime,
  emailBaseLayout,
  emailHeader,
  emailBodySection,
  emailHighlight,
  emailDetailRows,
  emailNote,
  emailButton,
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
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
}

// confirmationHtml/sendBookingConfirmation moved to
// apps/workers/booking/src/services/email.ts (WS-1) — the booking worker owns
// booking creation and sends the confirmation.

function reminderHtml(d: BookingEmailData): string {
  const address = d.shop_address?.trim();
  return emailBaseLayout(
    emailHeader(
      "⏰ Reminder: appointment tomorrow",
      `Hi ${d.customer_name}, just a reminder about your booking.`,
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
          ]) +
          emailNote(
            "We look forward to seeing you. If you need to cancel, please do so as soon as possible.",
          ),
      ),
    d.shop_name,
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendBookingReminder(
  apiKey: string,
  data: BookingEmailData,
): Promise<void> {
  await sendEmail(
    apiKey,
    data.customer_email,
    `Reminder: ${data.service_name} tomorrow at ${formatEmailTime(data.start_time, data.timezone)}`,
    reminderHtml(data),
  );
}

// ─── EOD Developer Alert ──────────────────────────────────────────────────────

export interface EodAlertData {
  developer_email: string;
  date: string; // "YYYY-MM-DD"
  booking_count: number;
  shop_count: number; // active shops with at least 1 booking today
}

function eodAlertHtml(d: EodAlertData): string {
  return emailBaseLayout(
    emailHeader(
      `📊 Daily summary: ${d.date}`,
      "End-of-day platform overview.",
    ) +
      emailBodySection(
        emailDetailRows([
          {
            label: "Bookings today",
            value: String(d.booking_count),
            accent: true,
          },
          { label: "Active shops", value: String(d.shop_count) },
        ]) +
          emailNote(
            "Pivot Parlor developer alert · Sent automatically at 20:00 UTC",
          ),
      ),
    "Pivot Parlor",
  );
}

export async function sendEodAlert(
  apiKey: string,
  data: EodAlertData,
): Promise<void> {
  await sendEmail(
    apiKey,
    data.developer_email,
    `Pivot Parlor: ${data.booking_count} booking${data.booking_count !== 1 ? "s" : ""} today (${data.date})`,
    eodAlertHtml(data),
  );
}

// ─── Email verification (SEC-3) ───────────────────────────────────────────────

export interface VerificationEmailData {
  to: string;
  name: string | null;
  verifyUrl: string;
}

function verificationHtml(d: VerificationEmailData): string {
  const greeting = d.name?.trim() ? `Hi ${d.name.trim()},` : "Hi,";
  return emailBaseLayout(
    emailHeader(
      "Confirm your email address",
      `${greeting} please confirm this address to finish setting up your account.`,
    ) +
      emailBodySection(
        emailNote(
          "Confirming your email lets you view and manage your bookings from your account.",
        ) +
          emailButton(d.verifyUrl, "Confirm email →") +
          emailNote(
            "This link expires in 24 hours. If you didn't create a Pivot Parlor account, you can ignore this email.",
          ),
      ),
    "Pivot Parlor",
    "You received this because an account was created with this address.",
  );
}

export async function sendVerificationEmail(
  apiKey: string,
  data: VerificationEmailData,
): Promise<void> {
  await sendEmail(
    apiKey,
    data.to,
    "Confirm your email address for Pivot Parlor",
    verificationHtml(data),
  );
}

// ─── Review Request ───────────────────────────────────────────────────────────

export interface ReviewRequestData {
  customer_name: string;
  customer_email: string;
  service_name: string;
  shop_name: string;
  shop_slug: string;
  booking_id: string;
}

function reviewRequestHtml(d: ReviewRequestData): string {
  const reviewUrl = `https://pivotparlor.com/${d.shop_slug}?review=${d.booking_id}`;
  return emailBaseLayout(
    emailHeader(
      "⭐ How was your visit?",
      `Hi ${d.customer_name}, we hope you enjoyed your appointment.`,
    ) +
      emailBodySection(
        `<p style="font-size:14px;line-height:1.6;color:#b3bac4;margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
        You recently had <strong style="color:#ffffff;">${d.service_name}</strong> at
        <strong style="color:#ffffff;">${d.shop_name}</strong>. We'd love to hear how it went.
      </p>` +
          emailButton(reviewUrl, "Leave a review →") +
          emailNote(
            "Takes less than a minute. Your feedback helps the shop improve.",
          ),
      ),
    d.shop_name,
  );
}

export async function sendReviewRequest(
  apiKey: string,
  data: ReviewRequestData,
): Promise<void> {
  await sendEmail(
    apiKey,
    data.customer_email,
    `How was your visit to ${data.shop_name}?`,
    reviewRequestHtml(data),
  );
}

// ─── Waitlist slot-opened ─────────────────────────────────────────────────────

export interface WaitlistSlotOpenData {
  customer_name: string;
  customer_email: string;
  shop_name: string;
  shop_slug: string;
  service_name?: string | null;
  preferred_date?: string | null;
}

/**
 * The waitlist signup is public, so customer_name (and via services,
 * service_name) is attacker-writable: without escaping, a signup could put
 * arbitrary HTML into a DKIM-signed platform email sent to an address the
 * attacker chose. Escape every interpolated value.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function waitlistSlotOpenHtml(d: WaitlistSlotOpenData): string {
  const customerName = escapeHtml(d.customer_name);
  const shopName = escapeHtml(d.shop_name);
  const bookUrl = `https://pivotparlor.com/${encodeURIComponent(d.shop_slug)}/book`;
  const what = d.service_name
    ? `a slot for <strong style="color:#ffffff;">${escapeHtml(d.service_name)}</strong>`
    : "a slot";
  const when = d.preferred_date
    ? ` on <strong style="color:#ffffff;">${escapeHtml(formatEmailDate(d.preferred_date))}</strong>`
    : "";
  return emailBaseLayout(
    emailHeader(
      "🎉 A slot just opened",
      `Hi ${customerName}, good news from ${shopName}.`,
    ) +
      emailBodySection(
        `<p style="font-size:14px;line-height:1.6;color:#b3bac4;margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
        You asked us to let you know when ${what}${when} became available at
        <strong style="color:#ffffff;">${shopName}</strong>. One just did.
      </p>` +
          emailButton(bookUrl, "Book now →") +
          emailNote(
            "Slots are first come, first served, so book soon. If you have already booked, you can ignore this email.",
          ),
      ),
    shopName,
  );
}

export async function sendWaitlistSlotOpen(
  apiKey: string,
  data: WaitlistSlotOpenData,
): Promise<void> {
  await sendEmail(
    apiKey,
    data.customer_email,
    `A slot just opened at ${data.shop_name}`,
    waitlistSlotOpenHtml(data),
  );
}
