import { useFetcher, useLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useEffect, useState } from "react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";

const DAY_LABELS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

interface StaffMember { id: string; display_name: string; user_email: string }
interface ScheduleRow { staff_id: string; day_of_week: number; start_time: string; end_time: string; is_active: number }

function buildTimeOptions() {
  const out: string[] = [];
  for (let h = 6; h <= 23; h++) {
    for (const m of [0, 30]) {
      if (h === 23 && m === 30) break;
      out.push(`${String(h).padStart(2,"0")}:${m === 0 ? "00" : "30"}`);
    }
  }
  return out;
}
const TIME_OPTIONS = buildTimeOptions();

type CellState = { open: boolean; start: string; end: string };
type Grid = Record<string, Record<number, CellState>>; // staffId → dayOfWeek → cell

function buildGrid(staff: StaffMember[], schedules: ScheduleRow[]): Grid {
  const g: Grid = {};
  for (const s of staff) {
    g[s.id] = {};
    for (let d = 0; d < 7; d++) {
      g[s.id][d] = { open: false, start: "09:00", end: "17:00" };
    }
  }
  for (const row of schedules) {
    if (g[row.staff_id]) {
      g[row.staff_id][row.day_of_week] = {
        open: row.is_active === 1,
        start: row.start_time,
        end: row.end_time,
      };
    }
  }
  return g;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = user.shop_id;

  let staff: StaffMember[] = [];
  let schedules: ScheduleRow[] = [];

  if (shopId) {
    try { staff = await api.get<StaffMember[]>(`/api/shops/${shopId}/staff`); } catch { /* empty */ }
    try {
      const res = await api.get<{ schedules: ScheduleRow[] }>(`/api/shops/${shopId}/schedule`);
      schedules = res?.schedules ?? [];
    } catch { /* empty */ }
  }

  return json({ staff, schedules, shopId });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token || !user.shop_id) return json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const api = createApiClient(env.API_URL, token);
  const body = await request.json() as { entries: unknown[] };

  try {
    await api.put(`/api/shops/${user.shop_id}/schedule`, body);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Save failed" }, { status: 400 });
  }
}

export default function AdminSchedule() {
  const { staff, schedules } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [grid, setGrid] = useState<Grid>(() => buildGrid(staff, schedules));
  const [toast, setToast] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setGrid(buildGrid(staff, schedules));
  }, [staff, schedules]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    setToast(fetcher.data.ok
      ? { type: "success", text: "Schedule saved." }
      : { type: "error",   text: fetcher.data.error ?? "Save failed." }
    );
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [fetcher.state, fetcher.data]);

  const save = () => {
    const entries: object[] = [];
    for (const staffId of Object.keys(grid)) {
      for (let d = 0; d < 7; d++) {
        const cell = grid[staffId][d];
        entries.push({
          staff_id: staffId,
          day_of_week: d,
          start_time: cell.start,
          end_time: cell.end,
          off: !cell.open,
        });
      }
    }
    fetcher.submit(
      { entries } as unknown as Record<string, string>,
      { method: "POST", encType: "application/json" }
    );
  };

  const setCell = (staffId: string, day: number, patch: Partial<CellState>) => {
    setGrid(prev => ({
      ...prev,
      [staffId]: { ...prev[staffId], [day]: { ...prev[staffId][day], ...patch } },
    }));
  };

  if (staff.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Schedule</h1>
        <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-white/30">
          No staff members yet. Add staff first.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg ${
          toast.type === "success"
            ? "border-emerald-500/40 bg-emerald-950/90 text-emerald-100"
            : "border-red-500/40 bg-red-950/90 text-red-100"
        }`} role="status">{toast.text}</div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Schedule</h1>
          <p className="mt-0.5 text-sm text-white/40">Set weekly working hours per staff member</p>
        </div>
        <Button size="sm" onClick={save} disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "Saving…" : "Save schedule"}
        </Button>
      </div>

      <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider w-36">Staff</th>
              {DAY_LABELS.map(d => (
                <th key={d} className="px-2 py-3 text-left text-xs font-semibold text-white/40 uppercase tracking-wider">{d.slice(0,3)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {staff.map(member => (
              <tr key={member.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-3">
                  <p className="font-medium text-white truncate max-w-[8rem]">{member.display_name}</p>
                </td>
                {Array.from({ length: 7 }, (_, d) => {
                  const cell = grid[member.id]?.[d] ?? { open: false, start: "09:00", end: "17:00" };
                  return (
                    <td key={d} className="px-2 py-2">
                      <div className="flex flex-col gap-1 min-w-[7rem]">
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cell.open}
                            onChange={e => setCell(member.id, d, { open: e.target.checked })}
                            className="h-3.5 w-3.5 rounded border-white/30 bg-white/5 text-gold focus:ring-gold"
                          />
                          <span className={cell.open ? "text-white/80" : "text-white/30"}>
                            {cell.open ? "Open" : "Off"}
                          </span>
                        </label>
                        {cell.open && (
                          <div className="flex gap-1 items-center">
                            <select
                              value={cell.start}
                              onChange={e => setCell(member.id, d, { start: e.target.value })}
                              className="flex-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-white focus:border-gold focus:outline-none"
                            >
                              {TIME_OPTIONS.map(t => <option key={t} value={t} className="bg-dark">{t}</option>)}
                            </select>
                            <span className="text-white/30 text-xs">–</span>
                            <select
                              value={cell.end}
                              onChange={e => setCell(member.id, d, { end: e.target.value })}
                              className="flex-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-white focus:border-gold focus:outline-none"
                            >
                              {TIME_OPTIONS.map(t => <option key={t} value={t} className="bg-dark">{t}</option>)}
                            </select>
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
