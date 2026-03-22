const STRIPE_API = "https://api.stripe.com/v1";

function formEncode(data: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

async function stripePost(secret: string, path: string, body: Record<string, string | number | undefined | null>) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string } })?.error?.message ?? text.slice(0, 500);
    throw new Error(`Stripe ${res.status}: ${err}`);
  }
  return json as Record<string, unknown>;
}

export async function createPaymentIntentManualCapture(params: {
  secret: string;
  amountPence: number;
  currency: string;
  destinationAccount: string;
  applicationFeePence: number;
  metadata: Record<string, string>;
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
  const data = await stripePost(params.secret, "/payment_intents", metaFlat);
  return { id: String(data.id), client_secret: String(data.client_secret ?? "") };
}

export async function capturePaymentIntent(
  secret: string,
  paymentIntentId: string,
  options?: { amountPence?: number }
): Promise<Record<string, unknown>> {
  const body =
    options?.amountPence != null
      ? new URLSearchParams({ amount_to_capture: String(options.amountPence) }).toString()
      : undefined;
  const res = await fetch(`${STRIPE_API}/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string } })?.error?.message ?? text.slice(0, 500);
    throw new Error(`Stripe capture ${res.status}: ${err}`);
  }
  return json as Record<string, unknown>;
}

export async function createPaymentIntentAutoCapture(params: {
  secret: string;
  amountPence: number;
  currency: string;
  destinationAccount: string;
  applicationFeePence: number;
  metadata: Record<string, string>;
}): Promise<{ id: string; client_secret: string }> {
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
  const data = await stripePost(params.secret, "/payment_intents", metaFlat);
  return { id: String(data.id), client_secret: String(data.client_secret ?? "") };
}
