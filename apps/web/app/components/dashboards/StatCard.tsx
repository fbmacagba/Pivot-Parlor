import { type LucideIcon } from "lucide-react";
import { clsx } from "clsx";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  trend?: { value: number; label: string };
  className?: string;
}

export function StatCard({ label, value, icon: Icon, trend, className }: StatCardProps) {
  return (
    <div
      className={clsx(
        "rounded-xl border border-white/10 bg-dark-100 p-5",
        className
      )}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-white/50">{label}</p>
          <p className="mt-1 font-heading text-3xl font-bold text-white">{value}</p>
        </div>
        {Icon && (
          <div className="rounded-lg bg-gold/10 p-2.5">
            <Icon className="h-5 w-5 text-gold" />
          </div>
        )}
      </div>
      {trend && (
        <p
          className={clsx(
            "mt-3 text-xs",
            trend.value >= 0 ? "text-emerald-400" : "text-red-400"
          )}
        >
          {trend.value >= 0 ? "↑" : "↓"} {Math.abs(trend.value)}% {trend.label}
        </p>
      )}
    </div>
  );
}
