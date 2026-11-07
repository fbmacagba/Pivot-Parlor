import type { Density, Motif } from "@repo/utils";

type HoursRecord = Record<string, string | null | undefined>;

export function parseHours(json?: string): HoursRecord | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as unknown;
    if (!o || typeof o !== "object") return null;
    return o as HoursRecord;
  } catch {
    return null;
  }
}

/** At least one day carries opening times ("" and "closed" mean closed). */
export function hasOpenDay(json?: string): boolean {
  const hours = parseHours(json);
  if (!hours) return false;
  return Object.values(hours).some((v) => typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "closed");
}

export function formatReviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function StarRow({ rating, className }: { rating: number; className?: string }) {
  const full = Math.round(Math.min(5, Math.max(0, rating)));
  return (
    <span className={className} aria-hidden>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= full ? "text-[color:var(--st-accent-text)]" : "text-[color:var(--st-ink-25)]"}>
          ★
        </span>
      ))}
    </span>
  );
}

/** Match the booking/owner UI: show pennies only when the price has them,
 *  so the figure on the card equals the total shown at checkout. */
export function formatPrice(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2);
}

/** The normaliser assigns "Service" to uncategorised items; treat it as no category. */
export function isGenericCategory(category?: string | null): boolean {
  return !category || !category.trim() || category.trim().toLowerCase() === "service";
}

export function HoursTable({ hoursJson }: { hoursJson?: string }) {
  const hours = parseHours(hoursJson);
  const rows = [
    { k: "mon", label: "Monday" },
    { k: "tue", label: "Tuesday" },
    { k: "wed", label: "Wednesday" },
    { k: "thu", label: "Thursday" },
    { k: "fri", label: "Friday" },
    { k: "sat", label: "Saturday" },
    { k: "sun", label: "Sunday" },
  ] as const;

  return (
    <table className="w-full text-left text-sm text-[color:var(--st-ink-80)]">
      <tbody>
        {rows.map(({ k, label }) => {
          const v = hours?.[k];
          const raw = v == null ? "" : String(v).trim();
          // "09:00-18:00" reads as a range; an empty or "closed" day reads Closed.
          const text = !raw || raw.toLowerCase() === "closed" ? "Closed" : raw.replace(/\s*-\s*/, " to ");
          return (
            <tr key={k} className="border-b border-[color:var(--st-line-10)]">
              <th className="py-3 pr-4 font-medium text-[color:var(--st-ink-90)]">{label}</th>
              <td className="py-3">{text}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Vertical rhythm for NEW v3 variants only (existing sections keep their
 *  hardcoded padding — parity). Callers add their own horizontal padding. */
export function sectionPadY(density: Density): string {
  return density === "compact" ? "py-12 md:py-16" : "py-16 md:py-24";
}

/** Decorative accent for new-variant heroes and signature sections only.
 *  "line" renders in-flow (caller places it, usually with w-fit/mb-*);
 *  "dot-grid" and "arc" are absolutely positioned via className. Always
 *  aria-hidden, always token colours. */
export function MotifDecor({ motif, className = "" }: { motif: Motif; className?: string }) {
  if (motif === "none") return null;
  if (motif === "line") {
    return (
      <span className={`pointer-events-none flex items-center gap-3 ${className}`} aria-hidden>
        <span className="h-px w-16 bg-[color:var(--st-accent-40)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--st-accent-40)]" />
      </span>
    );
  }
  if (motif === "dot-grid") {
    return (
      <span
        className={`pointer-events-none absolute h-40 w-40 ${className}`}
        style={{
          backgroundImage: "radial-gradient(var(--st-accent-25) 1.5px, transparent 1.5px)",
          backgroundSize: "14px 14px",
        }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className={`pointer-events-none absolute h-72 w-72 rounded-full border border-[color:var(--st-accent-15)] ${className}`}
      aria-hidden
    />
  );
}
