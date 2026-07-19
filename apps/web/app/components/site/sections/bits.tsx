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
          const text = v == null || v === "" ? "Closed" : String(v);
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
