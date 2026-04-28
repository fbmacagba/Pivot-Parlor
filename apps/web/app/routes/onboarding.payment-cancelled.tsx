import type { MetaFunction } from "@remix-run/cloudflare";
import { Link } from "@remix-run/react";

export const meta: MetaFunction = () => [
  { title: "Payment cancelled — Pivot Parlor" },
];

export default function PaymentCancelled() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-md text-center space-y-6">
        <h1 className="font-heading text-2xl font-bold text-white">
          Payment was cancelled
        </h1>
        <p className="text-white/60">
          Please contact us to restart the process.
        </p>
        <Link
          to="/"
          className="inline-block text-sm text-gold hover:underline"
        >
          Return home
        </Link>
      </div>
    </div>
  );
}
