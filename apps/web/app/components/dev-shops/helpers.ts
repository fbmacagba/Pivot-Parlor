// Pure helpers for the developer "Shops" dashboard (dev.shops route).
// Extracted from dev.shops.tsx (T7.7) — no behavior change.
import type { RegenStepUiState } from "./types";

/** True once a generation job has reached a terminal state (nothing more will
 *  happen). Mirrors the display's jobComplete/jobFailed test so the poller and
 *  the UI agree on when to stop. */
export function isTerminalJobState(status: string, stage: string): boolean {
  const st = (status || "").toLowerCase();
  const sg = (stage || "").toLowerCase();
  return st === "complete" || st === "failed" || sg === "complete" || sg === "done";
}

// ─── Progress-poll failure floor ──────────────────────────────────────────────
// The poll endpoint keeps returning a non-terminal state forever when a pipeline
// worker crashes/drops a job (real prod repro: a job orphaned at
// {status:"queued", stage:"research"}). Stopping only on a terminal state means
// the poller then loops indefinitely and the bar freezes on "Researching brand
// & style". These bounds give the poll a floor so it always resolves.

/** The research worker advances to `parallel` or `failed` within ~2 min (≤4
 *  attempts, 0/3/6/9s backoff + model latency). A job still in a pre-parallel
 *  stage well past that has been orphaned — surface it long before the overall
 *  cap so the common freeze case fails fast instead of spinning. */
export const POLL_RESEARCH_STALL_MS = 5 * 60_000;

/** Overall backstop. The slowest legitimate path is the assembler waiting on a
 *  slow image model (ASSEMBLE_MAX_RETRIES × 60s ≈ 20 min in the builder worker),
 *  so this sits above that: any job that has not reached a terminal state by now
 *  is treated as stalled. */
export const POLL_OVERALL_MAX_MS = 25 * 60_000;

/** Stop after this many consecutive endpoint failures (~30s at a 3s interval) so
 *  a deleted job or an unavailable status service doesn't loop forever either. */
export const POLL_MAX_CONSECUTIVE_FAILURES = 10;

export type PollDecision =
  | { kind: "update" } // healthy in-flight poll: reflect it, keep polling
  | { kind: "terminal" } // complete/failed: reflect it, stop
  | { kind: "keep-going" } // transient endpoint failure: ignore, keep polling
  | { kind: "stalled"; message: string } // no progress within the bounds: stop, surface
  | { kind: "give-up"; message: string }; // too many endpoint failures: stop, surface

/** Decide what the progress poller should do with one status response. Pure so
 *  the poller's failure floor is unit-testable; the effect only owns the timer,
 *  the fetch, and applying the decision. */
export function decidePollAction(input: {
  /** The status fetch succeeded AND returned success:true with a data payload. */
  ok: boolean;
  status: string;
  stage: string;
  /** Milliseconds since polling this job began. */
  elapsedMs: number;
  /** Consecutive failed polls including this one (0 when ok). */
  consecutiveFailures: number;
}): PollDecision {
  const { ok, status, stage, elapsedMs, consecutiveFailures } = input;

  if (!ok) {
    return consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES
      ? {
          kind: "give-up",
          message: "Lost contact with the generation service. Refresh to check whether it finished.",
        }
      : { kind: "keep-going" };
  }

  if (isTerminalJobState(status, stage)) return { kind: "terminal" };

  const sg = (stage || "").toLowerCase();
  const preParallel = sg === "" || sg === "queued" || sg === "pending" || sg === "research";
  if (preParallel && elapsedMs >= POLL_RESEARCH_STALL_MS) {
    return {
      kind: "stalled",
      message: "Generation stalled during research and stopped making progress. Please try again.",
    };
  }
  if (elapsedMs >= POLL_OVERALL_MAX_MS) {
    return {
      kind: "stalled",
      message: "Generation is taking longer than expected. Refresh to check whether it finished.",
    };
  }

  return { kind: "update" };
}

/** Body for a site-regeneration request from the expanded dev editor.
 *  `includeImages` false keeps the fast path that reuses the existing
 *  hero/logo/catalog images (skip_images); true regenerates them (hero, logo,
 *  service photos). A chosen palette overrides the AI's colours; "auto"
 *  (palette null/omitted) leaves both out so the AI picks. */
export function buildRegeneratePayload(opts: {
  includeImages: boolean;
  palette?: { primary: string; accent: string } | null;
}): { skip_images: boolean; color_primary?: string; color_accent?: string } {
  const body: { skip_images: boolean; color_primary?: string; color_accent?: string } = {
    skip_images: !opts.includeImages,
  };
  if (opts.palette) {
    body.color_primary = opts.palette.primary;
    body.color_accent = opts.palette.accent;
  }
  return body;
}

/** Map Worker job status/stage to the 7-row progress UI (indices 0–6). */
export function regenJobStepStates(status: string, stage: string): RegenStepUiState[] {
  const st = (status || "").toLowerCase();
  const sg = (stage || "").toLowerCase();
  const out: RegenStepUiState[] = Array(7).fill("pending") as RegenStepUiState[];

  if (st === "failed") {
    if (sg === "research") {
      out[0] = "failed";
      return out;
    }
    if (sg === "parallel") {
      out[0] = "done";
      out[1] = "failed";
      return out;
    }
    if (sg === "assemble" || sg === "assembling" || sg === "audit") {
      for (let i = 0; i < 5; i++) out[i] = "done";
      out[5] = "failed";
      return out;
    }
    out[0] = "failed";
    return out;
  }

  if (st === "complete" || sg === "complete" || sg === "done") {
    return Array(7).fill("done") as RegenStepUiState[];
  }

  if (sg === "assemble" || sg === "assembling") {
    for (let i = 0; i < 5; i++) out[i] = "done";
    out[5] = "active";
    return out;
  }

  if (sg === "parallel") {
    out[0] = "done";
    out[1] = "active";
    out[2] = "active";
    out[3] = "active";
    out[4] = "active";
    return out;
  }

  if (sg === "audit" && st === "running") {
    for (let i = 0; i < 5; i++) out[i] = "done";
    out[5] = "active";
    return out;
  }

  if (sg === "research" && (st === "queued" || st === "running" || st === "processing")) {
    out[0] = "active";
    return out;
  }

  out[0] = "active";
  return out;
}

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** If worker returns a root-relative asset URL, resolve against API origin (Pages origin would 404). */
export function resolvePublicAssetImageUrl(raw: string, apiBase: string | undefined): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  const base = (apiBase ?? "").trim().replace(/\/$/, "");
  if (!base) return t;
  if (t.startsWith("/")) return `${base}${t}`;
  return t;
}

/** Append cache-bust query so the browser reloads after upload/save. */
export function withImageCacheBust(url: string, bust: number): string {
  if (!url || bust <= 0) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${bust}`;
}
