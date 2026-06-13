import { describe, expect, it } from "vitest";
import { MAX_QUEUE_DELAY_S, reminderDelaySeconds } from "../src/services/reminder";

const NOW = new Date("2027-01-04T10:00:00.000Z");
const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);

describe("reminderDelaySeconds (T6.1)", () => {
  it("returns the exact remaining seconds within one queue hop (≤12h)", () => {
    expect(reminderDelaySeconds(at(2), NOW)).toBe(2 * 3600);
    expect(reminderDelaySeconds(at(12), NOW)).toBe(MAX_QUEUE_DELAY_S);
  });

  it("caps at 12h for longer waits (consumer re-delays the remainder)", () => {
    expect(reminderDelaySeconds(at(24), NOW)).toBe(MAX_QUEUE_DELAY_S);
    expect(reminderDelaySeconds(at(72), NOW)).toBe(MAX_QUEUE_DELAY_S);
  });

  it("returns 0 for due or past sendAt (deliver immediately)", () => {
    expect(reminderDelaySeconds(NOW, NOW)).toBe(0);
    expect(reminderDelaySeconds(at(-1), NOW)).toBe(0);
  });

  it("a 24h reminder completes within the retry budget: 12h hop + 12h hop -> due", () => {
    // producer hop
    let clock = NOW;
    let hops = 0;
    const sendAt = at(24);
    let delay = reminderDelaySeconds(sendAt, clock);
    while (delay > 0) {
      clock = new Date(clock.getTime() + delay * 1000);
      delay = reminderDelaySeconds(sendAt, clock);
      hops++;
      if (hops > 10) throw new Error("did not converge");
    }
    expect(clock.getTime()).toBeGreaterThanOrEqual(sendAt.getTime());
    expect(hops).toBeLessThanOrEqual(2);
  });
});
