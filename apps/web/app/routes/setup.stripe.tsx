// apps/web/app/routes/setup.stripe.tsx
// Step 4 of the setup gate: £100 Stripe payment to activate the shop

import { useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

export const meta: MetaFunction = () => [
  { title: "Complete Setup | Pivot Parlor" },
];

interface ShopStripeData {
  stripe_payment_status: string | null;
  stripe_checkout_url: string | null;
  name: string;
  slug: string;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  if (!user.shop_id) throw redirect("/admin");

  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  let shopData: ShopStripeData | null = null;
  try {
    shopData = await api.get<ShopStripeData>(`/api/shops/${user.shop_id}/stripe-status`);
  } catch { /* empty */ }

  // Already paid — redirect to admin dashboard
  if (shopData?.stripe_payment_status === "paid") {
    throw redirect("/admin?site_live=1");
  }

  return json({ shopData, shopId: user.shop_id });
}

export default function SetupStripe() {
  const { shopData } = useLoaderData<typeof loader>();

  const checkoutUrl = shopData?.stripe_checkout_url;
  const isPending = shopData?.stripe_payment_status === "awaiting_payment";

  return (
    <div className="min-h-screen bg-dark flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="text-center mb-10">
          <p className="font-heading text-2xl font-bold text-white">
            Pivot <span className="text-gold">Parlor</span>
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-dark-100 overflow-hidden">

          {/* Header */}
          <div className="bg-gold/10 border-b border-gold/20 px-6 py-5">
            <h1 className="font-heading text-xl font-bold text-white">One-time setup fee</h1>
            <p className="text-sm text-white/60 mt-1">
              Complete payment to activate your shop and go live.
            </p>
          </div>

          {/* Body */}
          <div className="px-6 py-6 space-y-5">

            {/* Price breakdown */}
            <div className="rounded-xl border border-white/10 bg-white/5 p-5 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-white/60">AI site build + setup</span>
                <span className="text-white font-medium">£80.00</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-white/60">Onboarding + training</span>
                <span className="text-white font-medium">£20.00</span>
              </div>
              <div className="border-t border-white/10 pt-3 flex justify-between">
                <span className="text-white font-semibold">Total (inc. VAT)</span>
                <span className="text-gold font-bold text-lg">£100.00</span>
              </div>
            </div>

            {/* What you get */}
            <div className="space-y-2">
              {[
                "AI-generated branded booking website",
                "Online booking live 24/7",
                "Staff scheduling & automated reminders",
                "No monthly fees, 10% commission only",
              ].map((item) => (
                <div key={item} className="flex items-center gap-2.5 text-sm text-white/70">
                  <svg className="w-4 h-4 text-gold shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                  {item}
                </div>
              ))}
            </div>

            {/* CTA */}
            {checkoutUrl ? (
              <a
                href={checkoutUrl}
                className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-gold text-dark font-bold text-sm hover:bg-gold/90 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
                Pay £100 with Stripe
              </a>
            ) : (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
                {isPending
                  ? "Your payment link is being prepared. Please refresh in a moment."
                  : "No payment link found. Please contact support@pivotparlor.com."}
              </div>
            )}

            <p className="text-center text-xs text-white/50">
              Secured by Stripe · Cancel anytime after payment
            </p>
          </div>
        </div>

        {/* Back link */}
        <p className="text-center mt-6">
          <a href="/admin" className="text-xs text-white/50 hover:text-white/60 transition-colors">
            ← Back to dashboard
          </a>
        </p>
      </div>
    </div>
  );
}
