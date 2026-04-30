// apps/web/app/components/admin/SetupGate.tsx
import { Link } from "@remix-run/react";

export interface SetupStatus {
  staff:    { done: boolean; count: number };
  services: { done: boolean; count: number };
  address:  { done: boolean };
  stripe:   { done: boolean; status: string };
  all_done: boolean;
  shop_status: string;
}

const STEPS = [
  {
    key: "staff" as const,
    label: "Add staff",
    desc: "Invite at least one team member",
    link: "/admin/staff",
    linkLabel: "Go to Staff",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    key: "services" as const,
    label: "Add services",
    desc: "Create at least one bookable service",
    link: "/admin/services",
    linkLabel: "Go to Services",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    key: "address" as const,
    label: "Set your address",
    desc: "Add your shop address so customers can find you",
    link: "/admin/settings",
    linkLabel: "Go to Settings",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    key: "stripe" as const,
    label: "Complete Stripe setup",
    desc: "Pay the £100 one-time setup fee to activate bookings",
    link: "/setup/stripe",
    linkLabel: "Complete Payment",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
  },
];

function StepRow({
  label,
  desc,
  link,
  linkLabel,
  icon,
  done,
  active,
}: {
  label: string;
  desc: string;
  link: string;
  linkLabel: string;
  icon: React.ReactNode;
  done: boolean;
  active: boolean;
}) {
  return (
    <div className={`flex items-center gap-4 rounded-xl border px-5 py-4 transition-all ${
      done
        ? "border-emerald-500/20 bg-emerald-500/5"
        : active
        ? "border-gold/30 bg-gold/5"
        : "border-white/8 bg-dark-100"
    }`}>
      {/* Icon / tick */}
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
        done ? "bg-emerald-500/15 text-emerald-400" : active ? "bg-gold/15 text-gold" : "bg-white/5 text-white/30"
      }`}>
        {done ? (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        ) : icon}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${done ? "text-white/50 line-through" : "text-white"}`}>
          {label}
        </p>
        <p className="text-xs text-white/40 mt-0.5">{desc}</p>
      </div>

      {/* Action */}
      {!done && active && (
        <Link
          to={link}
          className="shrink-0 flex items-center gap-1.5 text-xs font-semibold text-dark bg-gold hover:bg-gold/90 px-3 py-2 rounded-lg transition-colors"
        >
          {linkLabel}
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      )}
      {!done && !active && (
        <span className="shrink-0 text-xs text-white/20 font-medium">Locked</span>
      )}
      {done && (
        <span className="shrink-0 text-xs font-semibold text-emerald-400">Done</span>
      )}
    </div>
  );
}

export function SetupGate({ status }: { status: SetupStatus }) {
  const completedCount = [status.staff.done, status.services.done, status.address.done, status.stripe.done]
    .filter(Boolean).length;

  // First incomplete step is "active"
  const firstIncomplete = STEPS.findIndex((s) => !status[s.key].done);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">Welcome to Pivot Parlor</h1>
        <p className="mt-1 text-sm text-white/40">
          Complete these steps to go live and start taking bookings.
        </p>
      </div>

      {/* Progress bar */}
      <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-semibold text-white">Setup progress</span>
          <span className="text-sm font-bold text-gold">{completedCount} / 4</span>
        </div>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-gold transition-all duration-500"
            style={{ width: `${(completedCount / 4) * 100}%` }}
          />
        </div>
        <p className="text-xs text-white/30 mt-2">
          {completedCount === 4
            ? "All steps complete — your shop is ready to go live."
            : `${4 - completedCount} step${4 - completedCount !== 1 ? "s" : ""} remaining`}
        </p>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {STEPS.map((step, i) => {
          const { key: stepKey, ...stepProps } = step;
          return (
            <StepRow
              key={stepKey}
              {...stepProps}
              done={status[stepKey].done}
              active={i === firstIncomplete}
            />
          );
        })}
      </div>

      {/* Help text */}
      <p className="text-xs text-white/20 text-center">
        Need help? Contact{" "}
        <a href="mailto:support@pivotparlor.com" className="text-gold/60 hover:text-gold underline">
          support@pivotparlor.com
        </a>
      </p>
    </div>
  );
}
