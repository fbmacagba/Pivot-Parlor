import type { ShouldRevalidateFunction } from "@remix-run/react";

/**
 * Reload the page's data after a submission answered 409 Conflict.
 *
 * React Router 7 (single fetch) does not reload loaders after a submission
 * answered 4xx/5xx; Remix 2 did. For a validation error that is right: nothing
 * changed. A 409 means something did, underneath the page (the slot a visitor
 * tried to book was just taken), so the page must show the new state.
 */
export const revalidateAfterConflict: ShouldRevalidateFunction = ({ actionStatus, defaultShouldRevalidate }) =>
  actionStatus === 409 ? true : defaultShouldRevalidate;

/**
 * Reload the page's data after any failed submission, as Remix 2 always did.
 *
 * For dashboard pages whose actions turn an API conflict (a booking clash, a
 * refund or void race, a stock take in progress) into their own 400/502: the
 * status no longer says "conflict", but the data shown may have just changed.
 */
export const revalidateAfterFailedSubmission: ShouldRevalidateFunction = ({
  formMethod,
  actionStatus,
  defaultShouldRevalidate,
}) => (formMethod && actionStatus !== undefined && actionStatus >= 400 ? true : defaultShouldRevalidate);
