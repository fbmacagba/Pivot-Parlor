import { useEffect, useRef } from "react";

interface PollingOptions {
  /** Milliseconds between ticks. */
  intervalMs: number;
  /** False pauses polling without unmounting. */
  enabled?: boolean;
}

/**
 * Calls `tick` on an interval, but only while the page is visible, and once
 * straight away when the person comes back to it. A dashboard left open on a
 * phone in a pocket stops spending requests; picked up again, it is current.
 * A tick that is still running is never started a second time.
 */
export function usePolling(tick: () => void | Promise<void>, { intervalMs, enabled = true }: PollingOptions): void {
  const callback = useRef(tick);
  callback.current = tick;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    let running = false;
    const run = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await callback.current();
      } finally {
        running = false;
      }
    };
    const id = window.setInterval(run, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);
}
