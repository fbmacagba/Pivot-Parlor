/**
 * The booking wizard keeps its place in the URL, so a reload, a shared link or
 * returning from another tab restores the service, team member and day.
 *
 * Only choices are stored, never personal details, and never the time: a
 * time can be taken by someone else, so it is always picked again. The step
 * is therefore capped at the date-and-time step.
 *
 * `serviceId` and `staffId` are the deep-link names the shop pages already
 * use; `day` is distinct from the `date` the loader reads for slot lookups.
 */
import type { ShouldRevalidateFunction } from "@remix-run/react";

export const WIZARD_PARAMS = ["serviceId", "staffId", "day", "step"] as const;

/** The furthest step a URL can restore: 0 service, 1 team, 2 date and time. */
export const MAX_RESTORED_STEP = 2;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day the wizard may restore: well-formed, a real date, not in the past. */
export function restorableDay(day: string | null | undefined, today: string): string {
  if (!day || !ISO_DAY.test(day)) return "";
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return "";
  return day >= today ? day : "";
}

/** The step to open on: the URL's step, never further than the choices allow. */
export function restoredStep(args: { stepParam: string | null; hasService: boolean; hasStaff: boolean }): number {
  const allowed = args.hasService ? (args.hasStaff ? MAX_RESTORED_STEP : 1) : 0;
  const raw = args.stepParam === null || args.stepParam === "" ? NaN : Number(args.stepParam);
  if (!Number.isInteger(raw)) return allowed;
  return Math.max(0, Math.min(raw, allowed));
}

/** The URL's query for the wizard's current choices, other params kept. */
export function wizardSearch(
  current: URLSearchParams,
  state: { step: number; serviceId: string; staffId: string; day: string }
): URLSearchParams {
  const next = new URLSearchParams(current);
  const put = (key: string, value: string) => (value ? next.set(key, value) : next.delete(key));
  put("serviceId", state.serviceId);
  put("staffId", state.serviceId ? state.staffId : "");
  put("day", state.serviceId && state.staffId ? state.day : "");
  put("step", String(Math.min(Math.max(state.step, 0), MAX_RESTORED_STEP)));
  return next;
}

/**
 * Recording a choice in the URL must not reload the page's data (the shop
 * and the menu are already loaded, and a demo must make no extra request).
 * Anything else, including every form submission, revalidates as usual.
 */
export const skipRevalidationForWizardParams: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  const rest = (u: URL) => {
    const p = new URLSearchParams(u.search);
    for (const k of WIZARD_PARAMS) p.delete(k);
    p.sort();
    return p.toString();
  };
  return rest(currentUrl) === rest(nextUrl) ? false : defaultShouldRevalidate;
};
