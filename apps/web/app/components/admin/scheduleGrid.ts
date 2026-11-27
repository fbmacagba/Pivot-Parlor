/** The weekly hours grid behind the Schedule page: one cell per staff member per day. */

export const DAY_LABELS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface ScheduleStaff {
  id: string;
  display_name: string;
}

export interface ScheduleRow {
  staff_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: number;
}

export interface CellState {
  open: boolean;
  start: string;
  end: string;
}

/** staffId, then day of week (0 is Monday), then the cell. */
export type Grid = Record<string, Record<number, CellState>>;

export const DEFAULT_CELL: CellState = { open: false, start: "09:00", end: "17:00" };

/** "09:00:00" and "09:00" are the same time; the selects work in HH:MM. */
function clock(value: string): string {
  return /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : value;
}

export function buildGrid(staff: ScheduleStaff[], schedules: ScheduleRow[]): Grid {
  const g: Grid = {};
  for (const s of staff) {
    g[s.id] = {};
    for (let d = 0; d < 7; d++) g[s.id][d] = { ...DEFAULT_CELL };
  }
  for (const row of schedules) {
    if (g[row.staff_id]) {
      g[row.staff_id][row.day_of_week] = {
        open: row.is_active === 1,
        start: clock(row.start_time),
        end: clock(row.end_time),
      };
    }
  }
  return g;
}

export const ENDS_BEFORE_START = "Must finish after it starts.";

/** The key the page uses for one staff member's day. */
export function dayKey(staffId: string, day: number): string {
  return `${staffId}:${day}`;
}

/**
 * Working days that end at or before they start, as a message per day.
 * A day off is never an error: its times are not used.
 */
export function scheduleErrors(grid: Grid): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const staffId of Object.keys(grid)) {
    for (let d = 0; d < 7; d++) {
      const cell = grid[staffId]?.[d];
      if (cell?.open && clock(cell.end) <= clock(cell.start)) errors[dayKey(staffId, d)] = ENDS_BEFORE_START;
    }
  }
  return errors;
}

/** What the schedule API takes: every staff member's seven days. */
export function gridEntries(grid: Grid): Array<{
  staff_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  off: boolean;
}> {
  const entries = [];
  for (const staffId of Object.keys(grid)) {
    for (let d = 0; d < 7; d++) {
      const cell = grid[staffId]?.[d] ?? DEFAULT_CELL;
      entries.push({ staff_id: staffId, day_of_week: d, start_time: cell.start, end_time: cell.end, off: !cell.open });
    }
  }
  return entries;
}
