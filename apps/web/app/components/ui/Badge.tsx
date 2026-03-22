import { clsx } from "clsx";

type BadgeVariant =
  | "default"
  | "gold"
  | "success"
  | "warning"
  | "error"
  | "outline"
  | "anthropic"
  | "google";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-white/10 text-white/80",
  gold: "bg-gold/20 text-gold border border-gold/30",
  success: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30",
  warning: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
  error: "bg-red-500/20 text-red-400 border border-red-500/30",
  outline: "border border-white/20 text-white/70 bg-transparent",
  anthropic: "bg-orange-500/20 text-orange-400 border border-orange-500/30",
  google: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
};

export function Badge({ variant = "default", className, ...props }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}
