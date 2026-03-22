export function todayUtcYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addMinutesToHm(hm: string, addMin: number): string {
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return hm;
  let total = h * 60 + m + addMin;
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

export function minutesToHm(total: number): string {
  const t = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = Math.floor(t / 60);
  const mm = t % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Generate ["09:00","09:30",...] from start to end (exclusive of end), step minutes. */
export function generateSlotTimes(start: string, end: string, stepMin: number): string[] {
  const out: string[] = [];
  let cur = hmToMinutes(start);
  const endM = hmToMinutes(end);
  while (cur + stepMin <= endM) {
    out.push(minutesToHm(cur));
    cur += stepMin;
  }
  return out;
}
