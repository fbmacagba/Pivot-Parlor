import { useFetcher, useLoaderData, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { readJsonObject } from "@repo/utils";
import { useEffect, useRef, useState } from "react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { pageShopId } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { Button } from "~/components/ui/Button";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { ErrorScreen } from "~/components/ErrorScreen";
import {
  buildGrid,
  dayKey,
  DAY_LABELS,
  DEFAULT_CELL,
  gridEntries,
  scheduleErrors,
  type CellState,
  type Grid,
  type ScheduleRow,
} from "~/components/admin/scheduleGrid";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Schedule");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

interface StaffMember { id: string; display_name: string; user_email: string }

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

/** The half-hour list, plus the saved time when it is not on a half hour. */
function optionsWith(value: string): string[] {
  return TIME_OPTIONS.includes(value) ? TIME_OPTIONS : [...TIME_OPTIONS, value].sort();
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user);

  let staff: StaffMember[] = [];
  let schedules: ScheduleRow[] = [];
  let loadError = false;

  if (shopId) {
    const [staffRes, scheduleRes] = await Promise.allSettled([
      api.get<StaffMember[]>(`/api/shops/${shopId}/staff`),
      api.get<{ schedules: ScheduleRow[] }>(`/api/shops/${shopId}/schedule`),
    ]);
    if (staffRes.status === "fulfilled") staff = staffRes.value ?? [];
    else loadError = true;
    if (scheduleRes.status === "fulfilled") schedules = scheduleRes.value?.schedules ?? [];
    else loadError = true;
  }

  return json({ staff, schedules, shopId, loadError });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const shopId = pageShopId(request, user);
  if (!token || !shopId) return json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const body = await readJsonObject<{ entries?: unknown[] }>(request);
  if (!body) return json({ ok: false, error: "Invalid JSON" }, { status: 400 });

  const api = createApiClient(env.API_URL, token);

  try {
    await api.put(`/api/shops/${shopId}/schedule`, body);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : "Save failed" }, { status: 400 });
  }
}

export default function AdminSchedule() {
  const { staff, schedules, loadError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [grid, setGrid] = useState<Grid>(() => buildGrid(staff, schedules));
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  // Read by the effects below without making them re-run on every edit.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const editedSinceSave = useRef(false);
  const saving = fetcher.state !== "idle";

  // Fresh server data replaces the grid only when there is nothing unsaved
  // in it: a failed save reloads the page's data, and must not take the
  // owner's edits with it.
  useEffect(() => {
    if (!dirtyRef.current) setGrid(buildGrid(staff, schedules));
  }, [staff, schedules]);

  useFetcherResult(fetcher, (result) => {
    if (!result.ok) {
      setNotice({
        type: "error",
        text: `The schedule was not saved: ${result.error ?? "the request failed."} Your changes are still here.`,
      });
      return;
    }
    setNotice({ type: "success", text: "Schedule saved." });
    if (!editedSinceSave.current) {
      setDirty(false);
      setShowErrors(false);
      setGrid(buildGrid(staff, schedules));
    }
  });

  // Leaving with unsaved hours asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const errors = scheduleErrors(grid);
  const errorCount = Object.keys(errors).length;

  const save = () => {
    if (errorCount > 0) {
      setShowErrors(true);
      setNotice({
        type: "error",
        text:
          errorCount === 1
            ? "One working day finishes before it starts. Fix it, then save."
            : `${errorCount} working days finish before they start. Fix them, then save.`,
      });
      return;
    }
    setNotice(null);
    editedSinceSave.current = false;
    fetcher.submit(
      { entries: gridEntries(grid) } as unknown as Record<string, string>,
      { method: "POST", encType: "application/json" }
    );
  };

  const setCell = (staffId: string, day: number, patch: Partial<CellState>) => {
    editedSinceSave.current = true;
    setDirty(true);
    setNotice((n) => (n?.type === "success" ? null : n));
    setGrid(prev => ({
      ...prev,
      [staffId]: { ...prev[staffId], [day]: { ...(prev[staffId]?.[day] ?? DEFAULT_CELL), ...patch } },
    }));
  };

  if (loadError) {
    // No editable grid: blank hours must never be saved over the real ones.
    return (
      <div className="space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Schedule</h1>
        <LoadError what="your staff and their working hours" />
      </div>
    );
  }

  if (staff.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Schedule</h1>
        <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-white/60">
          No staff members yet. Add staff first, then set their working hours here.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Schedule</h1>
          <p className="mt-0.5 text-sm text-white/60">Set weekly working hours per staff member</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {dirty && !saving && <p className="text-sm font-medium text-amber-300">Unsaved changes</p>}
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save schedule"}
          </Button>
        </div>
      </div>

      {notice?.type === "success" && (
        <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          {notice.text}
        </p>
      )}
      {notice?.type === "error" && (
        <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {notice.text}
        </p>
      )}

      {/* Below md each staff member is a card with one row per day; from md up
          the same cells sit in a staff by day grid. One DOM, so the controlled
          inputs stay in sync. */}
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-dark-100">
        <div className="divide-y divide-white/5 md:min-w-[62rem]">
          <div
            aria-hidden
            className="hidden border-b border-white/10 md:grid md:grid-cols-[9rem_repeat(7,minmax(0,1fr))]"
          >
            <p className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-white/60">Staff</p>
            {DAY_LABELS.map((d) => (
              <p key={d} className="px-2 py-3 text-xs font-semibold uppercase tracking-wider text-white/60">
                {d.slice(0, 3)}
              </p>
            ))}
          </div>
          {staff.map((member) => {
            const headingId = `schedule-staff-${member.id}`;
            return (
              <div
                key={member.id}
                role="group"
                aria-labelledby={headingId}
                className="pb-2 md:grid md:grid-cols-[9rem_repeat(7,minmax(0,1fr))] md:pb-0"
              >
                <h2 id={headingId} className="truncate px-4 pb-1 pt-3 text-sm font-medium text-white md:py-3">
                  {member.display_name}
                </h2>
                {DAY_LABELS.map((dayName, d) => {
                  const cell = grid[member.id]?.[d] ?? DEFAULT_CELL;
                  const error = showErrors ? errors[dayKey(member.id, d)] : undefined;
                  return (
                    <div key={d} className="flex items-start gap-3 px-4 py-1 md:block md:px-2 md:py-2">
                      <span aria-hidden className="w-9 shrink-0 pt-3 text-xs font-semibold uppercase tracking-wider text-white/60 md:hidden">
                        {dayName.slice(0, 3)}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1 md:flex-col md:items-stretch md:gap-1">
                        <label className="tap-target flex cursor-pointer items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={cell.open}
                            onChange={e => setCell(member.id, d, { open: e.target.checked })}
                            aria-label={`${member.display_name} works ${dayName}`}
                            className="h-4 w-4 rounded border-white/40 bg-white/5 text-gold focus:ring-gold"
                          />
                          <span aria-hidden className={cell.open ? "font-semibold text-white" : "text-white/60"}>
                            {cell.open ? "Open" : "Off"}
                          </span>
                        </label>
                        {cell.open && (
                          <div className="flex min-w-[11rem] flex-1 items-start gap-1 md:min-w-0 md:flex-col md:items-stretch">
                            <div className="min-w-0 flex-1">
                              <Select
                                label={`${member.display_name}, ${dayName}, starts`}
                                hideLabel
                                value={cell.start}
                                onChange={e => setCell(member.id, d, { start: e.target.value })}
                              >
                                {optionsWith(cell.start).map(t => <option key={t} value={t} className="bg-dark">{t}</option>)}
                              </Select>
                            </div>
                            <span aria-hidden className="pt-3 text-xs text-white/60 md:hidden">to</span>
                            <div className="min-w-0 flex-1">
                              <Select
                                label={`${member.display_name}, ${dayName}, finishes`}
                                hideLabel
                                value={cell.end}
                                onChange={e => setCell(member.id, d, { end: e.target.value })}
                                error={error}
                              >
                                {optionsWith(cell.end).map(t => <option key={t} value={t} className="bg-dark">{t}</option>)}
                              </Select>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
