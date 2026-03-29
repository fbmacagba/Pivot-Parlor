// apps/worker/src/services/email.ts
// Resend email service — booking confirmation + 24h reminder

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
  booking_date: string;   // "YYYY-MM-DD"
  start_time: string;     // ISO string
  duration_min: number;
  amount: number;         // pounds
  booking_id: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours(); const m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

async function sendEmail(
  apiKey: string,
  to: string,
  subject: string,
  html: string
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

// ─── Email templates ──────────────────────────────────────────────────────────

function baseLayout(content: string, shopName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { margin:0; padding:0; background:#0d0d0d; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e2e8f0; }
  .wrap { max-width:560px; margin:0 auto; padding:40px 20px; }
  .card { background:#1a1a1a; border:1px solid #2d2d2d; border-radius:16px; overflow:hidden; }
  .header { background:#111; padding:28px 32px; border-bottom:1px solid #2d2d2d; }
  .header h1 { margin:0; font-size:20px; font-weight:700; color:#fff; }
  .header p { margin:4px 0 0; font-size:13px; color:#6b7280; }
  .body { padding:28px 32px; }
  .detail-row { display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid #2d2d2d; }
  .detail-row:last-child { border-bottom:none; }
  .detail-label { font-size:12px; color:#6b7280; font-weight:500; }
  .detail-value { font-size:13px; color:#e2e8f0; font-weight:600; text-align:right; }
  .highlight { background:#1c1c0a; border:1px solid #92400e; border-radius:10px; padding:16px 20px; margin:20px 0; }
  .highlight .date { font-size:22px; font-weight:700; color:#c9a84c; }
  .highlight .time { font-size:14px; color:#d4a853; margin-top:2px; }
  .btn { display:inline-block; background:#c9a84c; color:#0d0d0d; font-weight:700; font-size:14px; padding:13px 28px; border-radius:8px; text-decoration:none; margin-top:20px; }
  .footer { padding:20px 32px; text-align:center; font-size:11px; color:#4b5563; border-top:1px solid #2d2d2d; }
  .amount { font-size:18px; font-weight:700; color:#c9a84c; }
</style>
</head>
<body>
<div class="wrap">
  <div style="text-align:center;margin-bottom:24px;">
    <span style="font-size:13px;font-weight:700;color:#c9a84c;letter-spacing:0.1em;text-transform:uppercase;">Pivot Parlor</span>
  </div>
  <div class="card">
    ${content}
    <div class="footer">
      ${shopName} · Powered by Pivot Parlor<br/>
      You received this because you made a booking.
    </div>
  </div>
</div>
</body>
</html>`;
}

function confirmationHtml(d: BookingEmailData): string {
  return baseLayout(`
    <div class="header">
      <h1>✅ Booking confirmed</h1>
      <p>Hi ${d.customer_name}, your appointment is booked.</p>
    </div>
    <div class="body">
      <div class="highlight">
        <div class="date">${formatDate(d.booking_date)}</div>
        <div class="time">${formatTime(d.start_time)} · ${d.duration_min} min</div>
      </div>
      <div class="detail-row"><span class="detail-label">Service</span><span class="detail-value">${d.service_name}</span></div>
      <div class="detail-row"><span class="detail-label">With</span><span class="detail-value">${d.staff_name}</span></div>
      <div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">${d.shop_name}</span></div>
      <div class="detail-row"><span class="detail-label">Total</span><span class="detail-value amount">£${d.amount.toFixed(2)}</span></div>
      <p style="font-size:13px;color:#6b7280;margin-top:20px;">
        Need to cancel or reschedule? Reply to this email or contact the shop directly.
      </p>
    </div>
  `, d.shop_name);
}

function reminderHtml(d: BookingEmailData): string {
  return baseLayout(`
    <div class="header">
      <h1>⏰ Reminder: appointment tomorrow</h1>
      <p>Hi ${d.customer_name}, just a reminder about your booking.</p>
    </div>
    <div class="body">
      <div class="highlight">
        <div class="date">${formatDate(d.booking_date)}</div>
        <div class="time">${formatTime(d.start_time)} · ${d.duration_min} min</div>
      </div>
      <div class="detail-row"><span class="detail-label">Service</span><span class="detail-value">${d.service_name}</span></div>
      <div class="detail-row"><span class="detail-label">With</span><span class="detail-value">${d.staff_name}</span></div>
      <div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">${d.shop_name}</span></div>
      <p style="font-size:13px;color:#6b7280;margin-top:20px;">
        We look forward to seeing you. If you need to cancel, please do so as soon as possible.
      </p>
    </div>
  `, d.shop_name);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendBookingConfirmation(
  apiKey: string,
  data: BookingEmailData
): Promise<void> {
  await sendEmail(
    apiKey,
    data.customer_email,
    `Booking confirmed — ${data.service_name} at ${data.shop_name}`,
    confirmationHtml(data)
  );
}

export async function sendBookingReminder(
  apiKey: string,
  data: BookingEmailData
): Promise<void> {
  await sendEmail(
    apiKey,
    data.customer_email,
    `Reminder: ${data.service_name} tomorrow at ${formatTime(data.start_time)}`,
    reminderHtml(data)
  );
}

// ─── EOD Developer Alert ──────────────────────────────────────────────────────

export interface EodAlertData {
  developer_email: string;
  date: string;             // "YYYY-MM-DD"
  booking_count: number;
  shop_count: number;       // active shops with at least 1 booking today
}

function eodAlertHtml(d: EodAlertData): string {
  return baseLayout(`
    <div class="header">
      <h1>📊 Daily summary — ${d.date}</h1>
      <p>End-of-day platform overview.</p>
    </div>
    <div class="body">
      <div class="detail-row">
        <span class="detail-label">Bookings today</span>
        <span class="detail-value amount">${d.booking_count}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Active shops</span>
        <span class="detail-value">${d.shop_count}</span>
      </div>
      <p style="font-size:12px;color:#4b5563;margin-top:20px;">
        Pivot Parlor developer alert · Sent automatically at 20:00 UTC
      </p>
    </div>
  `, "Pivot Parlor");
}

export async function sendEodAlert(
  apiKey: string,
  data: EodAlertData
): Promise<void> {
  await sendEmail(
    apiKey,
    data.developer_email,
    `Pivot Parlor — ${data.booking_count} booking${data.booking_count !== 1 ? "s" : ""} today (${data.date})`,
    eodAlertHtml(data)
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
  return baseLayout(`
    <div class="header">
      <h1>⭐ How was your visit?</h1>
      <p>Hi ${d.customer_name}, we hope you enjoyed your appointment.</p>
    </div>
    <div class="body">
      <p style="font-size:14px;color:#9ca3af;margin-bottom:20px;">
        You recently had <strong style="color:#e2e8f0;">${d.service_name}</strong> at 
        <strong style="color:#e2e8f0;">${d.shop_name}</strong>. We'd love to hear how it went.
      </p>
      <a href="${reviewUrl}" class="btn">Leave a review →</a>
      <p style="font-size:12px;color:#4b5563;margin-top:20px;">
        Takes less than a minute. Your feedback helps the shop improve.
      </p>
    </div>
  `, d.shop_name);
}

export async function sendReviewRequest(
  apiKey: string,
  data: ReviewRequestData
): Promise<void> {
  await sendEmail(
    apiKey,
    data.customer_email,
    `How was your visit to ${data.shop_name}?`,
    reviewRequestHtml(data)
  );
}
