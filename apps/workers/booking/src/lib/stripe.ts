const STRIPE_API = "https://api.stripe.com/v1";

function formEncode(data: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

/** A Stripe API error. The message is unchanged from the plain Error this
 *  used to be; `code` is Stripe's machine-readable error code, when it sent one. */
export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

/** True when `err` is a Stripe API error carrying this error code. */
export function isStripeErrorCode(err: unknown, code: string): boolean {
  return err instanceof StripeApiError && err.code === code;
}

async function parseStripeResponse(res: Response, context: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const error = (json as { error?: { message?: string; code?: string } })?.error;
    const err = error?.message ?? text.slice(0, 500);
    throw new StripeApiError(
      `Stripe ${context} ${res.status}: ${err}`,
      res.status,
      typeof error?.code === "string" ? error.code : null
    );
  }
  return json as Record<string, unknown>;
}

/**
 * POST to Stripe. `idempotencyKey` makes retries and double-submits safe:
 * Stripe returns the original response for a repeated key instead of creating
 * a second object. Every money-moving call MUST pass one (WS-2).
 */
async function stripePost(
  secret: string,
  path: string,
  body: Record<string, string | number | undefined | null>,
  idempotencyKey?: string
) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: formEncode(body),
  });
  return parseStripeResponse(res, path);
}

async function stripeGet(secret: string, path: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  return parseStripeResponse(res, path);
}

// ─── PaymentIntents ───────────────────────────────────────────────────────────

export async function createPaymentIntentManualCapture(params: {
  secret: string;
  amountPence: number;
  currency: string;
  destinationAccount: string;
  applicationFeePence: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
}): Promise<{ id: string; client_secret: string }> {
  const metaFlat: Record<string, string | number | undefined> = {
    "payment_method_types[]": "card",
    amount: params.amountPence,
    currency: params.currency,
    capture_method: "manual",
    "transfer_data[destination]": params.destinationAccount,
    application_fee_amount: params.applicationFeePence,
  };
  for (const [k, v] of Object.entries(params.metadata)) {
    metaFlat[`metadata[${k}]`] = v;
  }
  const data = await stripePost(params.secret, "/payment_intents", metaFlat, params.idempotencyKey);
  return { id: String(data.id), client_secret: String(data.client_secret ?? "") };
}

export async function createPaymentIntentAutoCapture(params: {
  secret: string;
  amountPence: number;
  currency: string;
  destinationAccount: string;
  applicationFeePence: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
}): Promise<{ id: string; client_secret: string; latest_charge?: string }> {
  const metaFlat: Record<string, string | number | undefined> = {
    "payment_method_types[]": "card",
    amount: params.amountPence,
    currency: params.currency,
    capture_method: "automatic",
    "transfer_data[destination]": params.destinationAccount,
    application_fee_amount: params.applicationFeePence,
  };
  for (const [k, v] of Object.entries(params.metadata)) {
    metaFlat[`metadata[${k}]`] = v;
  }
  const data = await stripePost(params.secret, "/payment_intents", metaFlat, params.idempotencyKey);
  return {
    id: String(data.id),
    client_secret: String(data.client_secret ?? ""),
    latest_charge: data.latest_charge ? String(data.latest_charge) : undefined,
  };
}

/**
 * Hosted Checkout Session for a counter sale (WS-3 Phase 1). The customer
 * pays on their own phone via the returned URL (rendered as a QR at the
 * counter) — no card-present hardware and no Stripe.js in the dashboard.
 * The money is a destination charge on the shop's Connect account with the
 * platform commission as the application fee; metadata (incl. saleId)
 * propagates to the underlying PaymentIntent so the existing
 * payment_intent.succeeded webhook reconciles the sale.
 */
export async function createCheckoutSession(params: {
  secret: string;
  amountPence: number;
  currency: string;
  productName: string;
  destinationAccount: string;
  applicationFeePence: number;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  /** Unix seconds; Stripe accepts 30 min – 24 h from creation. Used by the
   *  customer deposit flow so an abandoned session frees the slot quickly. */
  expiresAtEpochS?: number;
}): Promise<{ id: string; url: string }> {
  const body: Record<string, string | number | undefined> = {
    mode: "payment",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": params.currency,
    "line_items[0][price_data][unit_amount]": params.amountPence,
    "line_items[0][price_data][product_data][name]": params.productName,
    "payment_intent_data[transfer_data][destination]": params.destinationAccount,
    "payment_intent_data[application_fee_amount]": params.applicationFeePence,
    ...(params.expiresAtEpochS ? { expires_at: params.expiresAtEpochS } : {}),
  };
  for (const [k, v] of Object.entries(params.metadata)) {
    body[`payment_intent_data[metadata][${k}]`] = v;
    body[`metadata[${k}]`] = v;
  }
  const data = await stripePost(params.secret, "/checkout/sessions", body, params.idempotencyKey);
  return { id: String(data.id), url: String(data.url ?? "") };
}

/**
 * Refund (part of) a destination-charge PaymentIntent (WS-3 Phase 2 returns).
 * refund_application_fee refunds the platform commission proportionally and
 * reverse_transfer pulls the refunded amount back from the connected account,
 * so shop and platform both give back their share. charge.refunded reconciles
 * the D1 side.
 */
export async function createRefund(params: {
  secret: string;
  paymentIntentId: string;
  amountPence: number;
  metadata: Record<string, string>;
  idempotencyKey: string;
}): Promise<{ id: string; status: string }> {
  const body: Record<string, string | number | undefined> = {
    payment_intent: params.paymentIntentId,
    amount: params.amountPence,
    refund_application_fee: "true",
    reverse_transfer: "true",
  };
  for (const [k, v] of Object.entries(params.metadata)) {
    body[`metadata[${k}]`] = v;
  }
  const data = await stripePost(params.secret, "/refunds", body, params.idempotencyKey);
  return { id: String(data.id), status: String(data.status ?? "") };
}

/**
 * Close an open Checkout Session so it can no longer be paid. Used when an
 * unpaid deposit booking is cancelled: the session would otherwise stay
 * payable until it lapses. Stripe refuses a session that is already complete
 * or expired, so callers treat this as best effort.
 */
export async function expireCheckoutSession(secret: string, sessionId: string): Promise<void> {
  await stripePost(secret, `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
}

export async function capturePaymentIntent(
  secret: string,
  paymentIntentId: string,
  options?: { amountPence?: number; idempotencyKey?: string }
): Promise<Record<string, unknown>> {
  const body: Record<string, string | number | undefined | null> = {};
  if (options?.amountPence != null) body.amount_to_capture = options.amountPence;
  return stripePost(
    secret,
    `/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`,
    body,
    options?.idempotencyKey
  );
}

export async function cancelPaymentIntent(
  secret: string,
  paymentIntentId: string,
  idempotencyKey?: string
): Promise<Record<string, unknown>> {
  return stripePost(
    secret,
    `/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
    {},
    idempotencyKey
  );
}

// ─── Connect (Express) ────────────────────────────────────────────────────────

export async function createConnectAccount(params: {
  secret: string;
  email: string;
  shopId: string;
  idempotencyKey: string;
}): Promise<{ id: string }> {
  const data = await stripePost(
    params.secret,
    "/accounts",
    {
      type: "express",
      country: "GB",
      email: params.email,
      "capabilities[card_payments][requested]": "true",
      "capabilities[transfers][requested]": "true",
      "metadata[shopId]": params.shopId,
    },
    params.idempotencyKey
  );
  return { id: String(data.id) };
}

export async function createAccountLink(params: {
  secret: string;
  account: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const data = await stripePost(params.secret, "/account_links", {
    account: params.account,
    refresh_url: params.refreshUrl,
    return_url: params.returnUrl,
    type: "account_onboarding",
  });
  return { url: String(data.url) };
}

export async function getAccount(secret: string, accountId: string): Promise<{
  id: string;
  charges_enabled: boolean;
  details_submitted: boolean;
  payouts_enabled: boolean;
}> {
  const data = await stripeGet(secret, `/accounts/${encodeURIComponent(accountId)}`);
  return {
    id: String(data.id),
    charges_enabled: Boolean(data.charges_enabled),
    details_submitted: Boolean(data.details_submitted),
    payouts_enabled: Boolean(data.payouts_enabled),
  };
}

// ─── Webhook signature verification ───────────────────────────────────────────

const encoder = new TextEncoder();

function hexEqualConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a Stripe-Signature header (t=...,v1=...) against the raw request
 * body. Constant-time comparison; rejects events older than `toleranceS` to
 * blunt replay. Returns true only for a valid, fresh signature.
 */
export async function verifyStripeSignature(
  payload: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  toleranceS = 300,
  nowMs = Date.now()
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parts = new Map<string, string[]>();
  for (const kv of signatureHeader.split(",")) {
    const [k, v] = kv.split("=", 2);
    if (!k || v === undefined) continue;
    const key = k.trim();
    if (!parts.has(key)) parts.set(key, []);
    parts.get(key)!.push(v);
  }
  const t = parts.get("t")?.[0];
  const v1s = parts.get("v1") ?? [];
  if (!t || v1s.length === 0) return false;

  const tsSec = Number(t);
  if (!Number.isFinite(tsSec)) return false;
  if (Math.abs(nowMs / 1000 - tsSec) > toleranceS) return false;

  const expected = await hmacSha256Hex(webhookSecret, `${t}.${payload}`);
  return v1s.some((v1) => hexEqualConstantTime(expected, v1.trim()));
}
