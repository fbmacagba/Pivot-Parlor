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
