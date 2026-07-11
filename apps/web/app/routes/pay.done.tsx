import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => [{ title: "Payment received | Pivot Parlor" }];

// Landing page for the POS Stripe QR flow — the customer sees this on their
// own phone after paying; the counter screen updates itself via polling.
export default function PayDone() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0D0D0D] px-6">
      <div className="max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-3xl">
          ✓
        </div>
        <h1 className="font-heading text-2xl font-bold text-white">Payment received</h1>
        <p className="mt-2 text-sm text-white/60">
          Thank you. You can show this screen to the staff — their till updates automatically.
        </p>
      </div>
    </main>
  );
}
