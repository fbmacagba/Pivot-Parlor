import { useEffect, useRef } from "react";
import { usePolling } from "~/lib/usePolling";
import { decidePollAction } from "./helpers";

/** One reading of a generation job (GET /api/jobs/:id/status). */
export interface JobSnapshot {
  status: string;
  stage: string;
  shopSlug?: string;
  error?: string;
  outcome?: string;
}

/** How following a job ended. Every ending is reported exactly once, so the
 *  caller can always clear its "generating" state. */
export type JobEnd =
  | { kind: "complete"; snapshot: JobSnapshot }
  /** The job failed, stopped making progress, or its status could not be read. */
  | { kind: "failed"; message: string; snapshot: JobSnapshot | null };

const POLL_MS = 3000;

async function readJob(jobId: string): Promise<JobSnapshot | undefined> {
  try {
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/status`, { cache: "no-store" });
    const j = (await r.json()) as { success?: boolean; data?: Partial<JobSnapshot> | null };
    if (!j.success || !j.data) return undefined;
    return {
      status: j.data.status ?? "",
      stage: j.data.stage ?? "",
      shopSlug: j.data.shopSlug ?? undefined,
      error: j.data.error ?? undefined,
      outcome: j.data.outcome ?? undefined,
    };
  } catch {
    return undefined; // counts as a failed poll
  }
}

/**
 * Follows one generation job until it ends. Polls every three seconds while
 * the page is visible (usePolling), never overlaps, and always ends: on a
 * terminal status, on a stall, or after too many unreadable answers
 * (decidePollAction holds those rules).
 */
export function useGenerationJob(
  jobId: string | null,
  handlers: { onProgress?: (snapshot: JobSnapshot) => void; onEnd: (end: JobEnd) => void },
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const run = useRef<{ jobId: string; startedAt: number; failures: number; ended: boolean; busy: boolean } | null>(null);

  const tick = async () => {
    const state = run.current;
    if (!state || state.ended || state.busy) return;
    state.busy = true;
    try {
      const snapshot = await readJob(state.jobId);
      // The job changed, or ended, while this answer was on its way.
      if (run.current !== state || state.ended) return;
      state.failures = snapshot ? 0 : state.failures + 1;
      const decision = decidePollAction({
        ok: snapshot !== undefined,
        status: snapshot?.status ?? "",
        stage: snapshot?.stage ?? "",
        elapsedMs: Date.now() - state.startedAt,
        consecutiveFailures: state.failures,
      });
      if (snapshot) latest.current.onProgress?.(snapshot);
      if (decision.kind === "terminal") {
        state.ended = true;
        if ((snapshot?.status ?? "").toLowerCase() === "failed") {
          latest.current.onEnd({
            kind: "failed",
            message: snapshot?.error?.trim() || "Generation failed. Nothing on the site was changed.",
            snapshot: snapshot ?? null,
          });
        } else {
          latest.current.onEnd({ kind: "complete", snapshot: snapshot! });
        }
      } else if (decision.kind === "stalled" || decision.kind === "give-up") {
        state.ended = true;
        latest.current.onEnd({ kind: "failed", message: decision.message, snapshot: snapshot ?? null });
      }
    } finally {
      state.busy = false;
    }
  };

  useEffect(() => {
    run.current = jobId ? { jobId, startedAt: Date.now(), failures: 0, ended: false, busy: false } : null;
    if (jobId) void tick();
    return () => {
      run.current = null;
    };
    // tick reads refs only, so the job id is the one thing that restarts this.
  }, [jobId]);

  usePolling(tick, { intervalMs: POLL_MS, enabled: Boolean(jobId) });
}

// ─── Remembering a running job across reloads and tabs ──────────────────────
// The server has no "which job is running for this shop" read, so the browser
// keeps the id it was given. A reload or a second tab picks it up and follows
// the same run; a different browser learns it from the 409 the server sends
// when a second run is asked for.

const KEY = (shopId: string) => `pp:generation-job:${shopId}`;
/** Jobs end, or are treated as stalled, within 30 minutes. */
const REMEMBER_MS = 30 * 60_000;

export function rememberJob(shopId: string, jobId: string): void {
  try {
    window.localStorage.setItem(KEY(shopId), JSON.stringify({ jobId, at: Date.now() }));
  } catch {
    /* private mode or storage full: following still works in this tab */
  }
}

export function forgetJob(shopId: string): void {
  try {
    window.localStorage.removeItem(KEY(shopId));
  } catch {
    /* nothing to forget */
  }
}

export function recallJob(shopId: string, now: number = Date.now()): string | null {
  try {
    const raw = window.localStorage.getItem(KEY(shopId));
    if (!raw) return null;
    const saved = JSON.parse(raw) as { jobId?: unknown; at?: unknown };
    if (typeof saved.jobId !== "string" || typeof saved.at !== "number" || now - saved.at > REMEMBER_MS) {
      window.localStorage.removeItem(KEY(shopId));
      return null;
    }
    return saved.jobId;
  } catch {
    return null;
  }
}
