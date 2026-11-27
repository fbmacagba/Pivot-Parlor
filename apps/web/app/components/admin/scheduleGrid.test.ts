import { describe, expect, it } from "vitest";
import { buildGrid, dayKey, ENDS_BEFORE_START, gridEntries, scheduleErrors } from "./scheduleGrid";

const staff = [
  { id: "sam", display_name: "Sam" },
  { id: "jo", display_name: "Jo" },
];

describe("scheduleErrors", () => {
  it("flags a working day that ends before or when it starts, per staff member and day", () => {
    const grid = buildGrid(staff, [
      { staff_id: "sam", day_of_week: 0, start_time: "09:00", end_time: "17:00", is_active: 1 },
      { staff_id: "sam", day_of_week: 1, start_time: "17:00", end_time: "09:00", is_active: 1 },
      { staff_id: "jo", day_of_week: 4, start_time: "10:00", end_time: "10:00", is_active: 1 },
    ]);
    expect(scheduleErrors(grid)).toEqual({
      [dayKey("sam", 1)]: ENDS_BEFORE_START,
      [dayKey("jo", 4)]: ENDS_BEFORE_START,
    });
  });

  it("ignores the times of a day off", () => {
    const grid = buildGrid(staff, [
      { staff_id: "sam", day_of_week: 2, start_time: "18:00", end_time: "08:00", is_active: 0 },
    ]);
    expect(scheduleErrors(grid)).toEqual({});
  });

  it("compares times with seconds as the same clock times", () => {
    const grid = buildGrid(staff, [
      { staff_id: "sam", day_of_week: 3, start_time: "09:00:00", end_time: "09:30:00", is_active: 1 },
    ]);
    expect(grid.sam[3]).toEqual({ open: true, start: "09:00", end: "09:30" });
    expect(scheduleErrors(grid)).toEqual({});
  });
});

describe("gridEntries", () => {
  it("sends seven days for every staff member, days off marked off", () => {
    const grid = buildGrid(staff, [
      { staff_id: "jo", day_of_week: 6, start_time: "10:00", end_time: "16:00", is_active: 1 },
    ]);
    const entries = gridEntries(grid);
    expect(entries).toHaveLength(14);
    expect(entries.filter((e) => !e.off)).toEqual([
      { staff_id: "jo", day_of_week: 6, start_time: "10:00", end_time: "16:00", off: false },
    ]);
  });
});
