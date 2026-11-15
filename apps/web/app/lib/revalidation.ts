import type { ShouldRevalidateFunction } from "react-router";

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
 * Every page with an action uses it, except the booking page (409 only, above).
 * Those actions answer an API refusal with a status of their own (a row deleted
 * elsewhere, a booking clash, a refund or void race all become 400 or 502), so
 * the status cannot say whether the data shown just changed. The page reloads
 * its own data, as under Remix 2; its layouts keep the router's default, and
 * each page's own loader checks the session.
 */
export const revalidateAfterFailedSubmission: ShouldRevalidateFunction = ({
  formMethod,
  actionStatus,
  defaultShouldRevalidate,
}) => (formMethod && actionStatus !== undefined && actionStatus >= 400 ? true : defaultShouldRevalidate);
