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
