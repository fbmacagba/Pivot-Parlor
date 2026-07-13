import { Link } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { Button } from "~/components/ui/Button";
import { Check } from "lucide-react";

export const meta: MetaFunction = () => [
  { title: "Pricing — £100 Setup, No Monthly Fees | Pivot Parlor" },
];

export default function Pricing() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="text-center mb-16">
          <h1 className="font-heading text-5xl font-bold text-white">
            We only earn <span className="text-gold">when you earn</span>
          </h1>
          <p className="mt-4 text-lg text-white/60">
            One-time £100 setup fee. No monthly fees. Then just 10% commission on completed bookings.
          </p>
        </div>

        <div className="rounded-2xl border border-gold/30 bg-dark-100 p-10 text-center mb-12">
          <div className="flex flex-wrap items-end justify-center gap-x-12 gap-y-6">
            {[["£100", "One-time setup"], ["£0", "Monthly fee"], ["10%", "Per booking"]].map(([val, label]) => (
              <div key={label}>
                <p className="font-heading text-6xl font-bold text-gold">{val}</p>
                <p className="mt-2 text-white/50">{label}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 text-left max-w-lg mx-auto">
            {[
              "AI-branded booking page",
              "Unlimited bookings",
              "Staff scheduling",
              "Waitlist management",
              "Automated reminders",
              "Commission dashboard",
              "Customer management",
              "99.99% uptime SLA",
            ].map((feat) => (
              <div key={feat} className="flex items-center gap-2 text-sm text-white/70">
                <Check className="h-4 w-4 text-gold shrink-0" />
                {feat}
              </div>
            ))}
          </div>

          <div className="mt-10">
            <Button asChild size="xl">
              <Link to="/contact">Get started →</Link>
            </Button>
            <p className="mt-3 text-xs text-white/60">£100 setup · No monthly fees · Live in 24 hours</p>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h3 className="font-heading text-lg font-semibold text-white mb-3">How commission works</h3>
          <p className="text-sm text-white/60 leading-relaxed">
            When a customer completes a booking through your Pivot Parlor page, we take 10% of the
            booking value as our commission. No-shows and cancellations are not charged. You see
            a full breakdown of all transactions in your dashboard in real time.
          </p>
        </div>
      </div>
    </main>
  );
}
