import { useRevalidator } from "react-router";
import { TriangleAlert } from "lucide-react";
import { Button } from "./Button";

interface LoadErrorProps {
  /** What failed to load, as the page calls it: "your bookings", "today's sales". */
  what: string;
  className?: string;
}

/**
 * Shown in place of a list (or above a form) when its data could not be
 * loaded. A failed load must never look like "nothing here": an owner who
 * reads "No bookings" when the request failed will act on it.
 */
export function LoadError({ what, className }: LoadErrorProps) {
  const revalidator = useRevalidator();
  const busy = revalidator.state !== "idle";
  return (
    <div
      role="alert"
      data-testid="load-error"
      className={`flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 ${className ?? ""}`}
    >
      <TriangleAlert className="h-4 w-4 shrink-0 text-amber-400" aria-hidden />
      <p className="min-w-[12rem] flex-1 text-sm text-amber-100">
        We couldn&apos;t load {what}. Nothing has been changed. Check your connection and try again.
      </p>
      <Button type="button" variant="secondary" size="sm" onClick={() => revalidator.revalidate()} disabled={busy}>
        {busy ? "Trying…" : "Try again"}
      </Button>
    </div>
  );
}
