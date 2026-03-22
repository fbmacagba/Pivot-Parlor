import type { MetaFunction } from "@remix-run/cloudflare";
import { Link } from "@remix-run/react";

export const meta: MetaFunction = () => [
  { title: "Payment confirmed — Pivot Parlor" },
];

export default function PaymentSuccess() {
  return (
    <div className="min-h-screen bg-[#0D0D0D] flex items-center justify-center px-4">
      <div className="w-full max-w-md text-center space-y-6">
        <h1 className="font-heading text-2xl font-bold text-white">
          Payment confirmed
        </h1>
        <p className="text-white/60">
          Your invite link will be sent shortly. You can now complete your account setup.
        </p>
        <Link
          to="/"
          className="inline-block text-sm text-[#C9A84C] hover:underline"
        >
          Return home
        </Link>
      </div>
    </div>
  );
}
